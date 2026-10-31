// 1 つの project の会話ごとに Coordinator を持ち、複数の会話を並列に動かす（DESIGN.md §28 D1）。
// 人が見ている会話（今の会話）は 1 つ。会話を切り替えても、前の会話の Agent は止めない
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import type { BrainstormConfig } from "../coordinator/brainstorm.js";
import type { Coordinator, RequestState } from "../coordinator/coordinator.js";
import type { CoordinatorEvent, EventBus } from "../coordinator/event-bus.js";
import { t } from "../i18n/i18n.js";
import type { Conversation, ConversationHistory } from "../project/conversation-history.js";
import { inside } from "../project/path-scope.js";
import type { ConversationRecovery, RecoveryState } from "../project/recovery-store.js";
import { resolveSpecFile } from "../project/spec-file.js";
import type { Worktree, WorktreeResult } from "../project/worktree.js";
import type { AgentMessage, CreateMessageResult } from "../protocol/messages.js";
import type { NotificationInput } from "./notify-format.js";

// 会話 1 つ分の実行環境（Event Bus・Coordinator・Agent・MCP server 等）
export interface ConversationRuntime {
  readonly conversationId: string;
  readonly workDir: string;
  readonly bus: EventBus;
  readonly coordinator: Coordinator;
  close(): Promise<void>;
}

export type ConversationActivity = "busy" | "idle" | "stopped";
export type WorktreeMoveResult =
  | { ok: true; worktree: Worktree }
  | { ok: false; reason: "already" }
  | { ok: false; reason: "busy"; agents: string }
  | { ok: false; reason: "failed"; error: string };

export type RuntimeEventListener = (runtime: ConversationRuntime, event: CoordinatorEvent, current: boolean) => void;
export interface WorkspaceOptions {
  notifyAgent(input: NotificationInput): void;
  isCurrentProject(): boolean;
  history: ConversationHistory;
  projectRoot: string;
  createRuntime: (conversation: Conversation) => Promise<ConversationRuntime>;
  createWorktree: (projectRoot: string, name: string) => Promise<WorktreeResult>;
  prepareWorktree?: (workDir: string) => Promise<void>;
}

export class Workspace {
  private readonly detach = new Map<string, () => void>();
  private readonly runtimes = new Map<string, ConversationRuntime>();
  private readonly creating = new Map<string, Promise<ConversationRuntime>>();
  private readonly eventListeners: RuntimeEventListener[] = [];
  private readonly switchListeners: Array<(runtime: ConversationRuntime) => void> = [];
  private readonly runtimeListeners: Array<(runtime: ConversationRuntime) => void> = [];
  private readonly recoveryListeners: Array<() => void> = [];
  private readonly toolUse = new Map<string, Partial<Record<AgentId, boolean>>>();
  private readonly pendingFailure = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly brainstormArtifacts = new Map<string, string>();

  constructor(private readonly options: WorkspaceOptions) {
    options.history.onRemove(id => {
      const runtime = this.runtimes.get(id);
      if (!runtime) return;
      this.detach.get(id)?.();
      this.detach.delete(id);
      this.runtimes.delete(id);
      void runtime.close().catch(error =>
        this.options.notifyAgent({
          kind: "error",
          projectRoot: this.options.projectRoot,
          line: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  async init(): Promise<void> {
    await this.ensure(this.options.history.current);
    for (const child of this.options.history.list().filter(conversation => conversation.parent)) await this.ensure(child);
  }

  // 今の会話の runtime。init 後と、切り替え（switchTo / startNew）の完了後は必ずある
  get current(): ConversationRuntime {
    const runtime = this.runtimes.get(this.options.history.currentId);
    if (!runtime) throw new Error("workspace is not initialized");
    return runtime;
  }

  // /sandbox の切り替えなどで runtime を作り直している間は無い。定期的な状態の表示はこちらを使う
  get currentIfReady(): ConversationRuntime | undefined {
    return this.runtimes.get(this.options.history.currentId);
  }

  // 全会話の event。current: 今の会話の event か
  onEvent(listener: RuntimeEventListener): void {
    this.eventListeners.push(listener);
  }

  // 今の会話が変わったとき
  onSwitch(listener: (runtime: ConversationRuntime) => void): void {
    this.switchListeners.push(listener);
  }

  onRuntime(listener: (runtime: ConversationRuntime) => void): void {
    this.runtimeListeners.push(listener);
  }

  onRecoveryChange(listener: () => void): void {
    this.recoveryListeners.push(listener);
  }

  allRuntimes(): ConversationRuntime[] {
    return [...this.runtimes.values()];
  }

  async startParallel(parentId: string, message: AgentMessage): Promise<{ thread: string } | { error: string }> {
    const id = randomUUID();
    let place: Pick<Conversation, "workDir" | "branch"> = {};
    if (message.worktree) {
      const created = await this.options.createWorktree(this.options.projectRoot, id);
      if (!created.ok) return { error: created.error };
      place = created.worktree;
    } else {
      const parent = this.options.history.list().find(conversation => conversation.id === parentId) ?? this.options.history.current;
      if (parent.workDir) place = { workDir: parent.workDir, ...(parent.branch ? { branch: parent.branch } : {}) };
    }
    const child = this.options.history.createChild(
      id,
      `${message.taskId}（並列）`,
      { conversationId: parentId, messageId: message.id, from: message.from, to: message.to },
      place,
    );
    try {
      await this.ensure(child);
      return { thread: id };
    } catch (error) {
      this.options.history.remove(id);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  forwardToParent(child: Conversation, message: AgentMessage): CreateMessageResult {
    const parent = child.parent;
    const runtime = parent ? this.runtimes.get(parent.conversationId) : undefined;
    return runtime && parent
      ? runtime.coordinator.receiveChildMessage(message, child.id, parent.messageId)
      : { ok: false, error: "parallel: parent conversation is unavailable" };
  }

  forwardFailureToParent(child: Conversation, message: AgentMessage, error: string): void {
    const parent = child.parent;
    const runtime = parent ? this.runtimes.get(parent.conversationId) : undefined;
    if (!runtime) throw new Error("parallel: parent conversation is unavailable");
    runtime.coordinator.reportDeliveryFailure(message, error);
  }

  async deliverToThread(thread: string, message: AgentMessage): Promise<void> {
    const runtime = this.runtimes.get(thread);
    if (!runtime) throw new Error(`parallel: conversation ${thread} is unavailable`);
    if (message.spec && message.repository !== runtime.workDir) {
      const source = resolveSpecFile(message.repository, message.spec);
      const target = resolve(runtime.workDir, message.spec.replace(/\\/g, "/"));
      if (!source || !inside(resolve(runtime.workDir), target)) throw new Error(`parallel: spec ${message.spec} is unavailable`);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    await runtime.coordinator.receiveForwardedMessage({ ...message, repository: runtime.workDir });
  }

  threadRequestState(thread: string, requestId: string, to: AgentId): RequestState {
    return this.runtimes.get(thread)?.coordinator.requestState(requestId, to) ?? "finished";
  }

  async discardParallel(thread: string): Promise<void> {
    const runtime = this.runtimes.get(thread);
    this.detach.get(thread)?.();
    this.detach.delete(thread);
    this.runtimes.delete(thread);
    if (runtime) await runtime.close();
    this.options.history.remove(thread);
  }

  recoveryConversations(): Record<string, ConversationRecovery> {
    const valid = new Set([...this.options.history.list().map(({ id }) => id), this.options.history.currentId]);
    return Object.fromEntries([...this.runtimes.entries()].filter(([id]) => valid.has(id)).map(([id, runtime]) => [id, runtime.coordinator.recoveryState()]));
  }

  async restore(state: RecoveryState): Promise<void> {
    const valid = new Map(this.options.history.list().map(conversation => [conversation.id, conversation]));
    for (const [id, recovery] of Object.entries(state.conversations)) {
      const conversation = valid.get(id);
      if (!conversation) continue;
      const runtime = await this.ensure(conversation);
      runtime.coordinator.restore(recovery);
    }
  }

  async switchTo(id: string): Promise<Conversation | undefined> {
    const conversation = this.options.history.switchTo(id);
    if (!conversation) return undefined;
    this.notifySwitch(await this.ensure(conversation));
    return conversation;
  }

  // worktree: 新しい会話用の worktree を作り、その会話の作業場所にする。作れなければ理由を返す（切り替えない）
  async startNew({ worktree = false, brainstorm }: { worktree?: boolean; brainstorm?: BrainstormConfig } = {}): Promise<string | undefined> {
    if (worktree) {
      const created = await this.options.createWorktree(this.options.projectRoot, randomUUID());
      if (!created.ok) return created.error;
      this.options.history.startNew(created.worktree);
    } else {
      this.options.history.startNew(brainstorm ? { mode: "brainstorm", brainstorm, title: brainstorm.topic } : {});
    }
    const runtime = await this.ensure(this.options.history.current);
    this.notifySwitch(runtime);
    if (brainstorm)
      void runtime.coordinator.startBrainstorm().catch(error => {
        runtime.bus.publish({ kind: "notice", text: error instanceof Error ? error.message : String(error), level: "warn" });
      });
    return undefined;
  }

  async develop(primary: AgentId, instruction: string): Promise<string | undefined> {
    const source = this.options.history.current;
    const artifact = this.brainstormArtifacts.get(source.id) ?? this.current.coordinator.brainstormArtifact;
    if (source.mode !== "brainstorm" || !source.brainstorm || !artifact) return t("notice.developUnavailable");
    this.options.history.startNew({ title: source.brainstorm.topic, from: { brainstorm: source.id } });
    const runtime = await this.ensure(this.options.history.current);
    this.notifySwitch(runtime);
    const text =
      `[Clodex] Continue from the brainstorm "${source.brainstorm.topic}". Read the summary at ${artifact}, then move the adopted ideas (adopted / adopted with changes) into development following your role (design document, delegation, and so on).` +
      (instruction ? `\nHuman instruction: ${instruction}` : "");
    void runtime.coordinator.sendToAgent(primary, text);
    return undefined;
  }

  async moveCurrentToWorktree(): Promise<WorktreeMoveResult> {
    if (this.options.history.current.workDir) return { ok: false, reason: "already" };
    const runtime = this.current;
    const busy = runtime.coordinator
      .status()
      .filter(agent => agent.status === "busy" || agent.status === "starting")
      .map(agent => agent.id);
    const queued = [...runtime.coordinator.pendingInputs(), ...runtime.coordinator.pendingMessages()].map(item => item.agent);
    if (!runtime.coordinator.idle() || busy.length) {
      return { ok: false, reason: "busy", agents: [...new Set([...busy, ...queued])].join(", ") || AGENT_IDS.join(", ") };
    }
    const created = await this.options.createWorktree(this.options.projectRoot, this.options.history.currentId);
    if (!created.ok) return { ok: false, reason: "failed", error: created.error };
    try {
      await this.options.prepareWorktree?.(created.worktree.workDir);
      const error = await runtime.coordinator.relocate(created.worktree.workDir);
      if (error) return { ok: false, reason: "failed", error };
      this.options.history.moveCurrentToWorktree(created.worktree);
      return created;
    } catch (error) {
      return { ok: false, reason: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  // runtime が無い会話は undefined（保存のみ）
  activity(conversationId: string): ConversationActivity | undefined {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return undefined;
    const statuses = runtime.coordinator.status().map(agent => agent.status);
    if (statuses.includes("busy") || statuses.includes("starting")) return "busy";
    return statuses.includes("idle") ? "idle" : "stopped";
  }

  // 同じ作業場所で、今の会話以外の Agent が作業中か（worktree を勧めるため）
  busyElsewhereInSameDir(): boolean {
    const current = this.current;
    return [...this.runtimes.values()].some(
      runtime => runtime !== current && runtime.workDir === current.workDir && this.activity(runtime.conversationId) === "busy",
    );
  }

  async closeAll(): Promise<void> {
    for (const timer of this.pendingFailure.values()) clearTimeout(timer);
    this.pendingFailure.clear();
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.close()));
  }

  async restart(): Promise<void> {
    for (const timer of this.pendingFailure.values()) clearTimeout(timer);
    this.pendingFailure.clear();
    this.toolUse.clear();
    const ids = [...this.runtimes.keys()];
    for (const detach of this.detach.values()) detach();
    this.detach.clear();
    this.runtimes.clear();
    const conversations = [...this.options.history.list(), this.options.history.current];
    for (const id of ids) {
      const conversation = conversations.find(item => item.id === id);
      if (conversation) await this.ensure(conversation);
    }
    this.notifySwitch(this.current);
    await Promise.all(
      this.allRuntimes()
        .filter(runtime => existsSync(runtime.workDir) && !conversations.find(item => item.id === runtime.conversationId)?.parent)
        .map(runtime => runtime.coordinator.start()),
    );
  }

  private notifySwitch(runtime: ConversationRuntime): void {
    for (const listener of this.switchListeners) listener(runtime);
  }

  private async ensure(conversation: Conversation): Promise<ConversationRuntime> {
    if (conversation.parent && !this.runtimes.has(conversation.parent.conversationId)) {
      const parent = this.options.history.list().find(entry => entry.id === conversation.parent?.conversationId) ?? this.options.history.current;
      if (parent.id !== conversation.id) await this.ensure(parent);
    }
    const existing = this.runtimes.get(conversation.id);
    if (existing) return existing;
    let creating = this.creating.get(conversation.id);
    if (!creating) {
      creating = this.options.createRuntime(conversation).then(runtime => {
        this.runtimes.set(conversation.id, runtime);
        const historyDetach = this.options.history.attach(runtime.bus, conversation.id);
        const eventDetach = runtime.bus.subscribe(event => this.handleEvent(runtime, event));
        const recoveryDetach = runtime.coordinator.onRecoveryChange(() => {
          for (const listener of this.recoveryListeners) listener();
        });
        this.detach.set(conversation.id, () => {
          historyDetach();
          eventDetach();
          recoveryDetach();
        });
        for (const listener of this.runtimeListeners) listener(runtime);
        return runtime;
      });
      this.creating.set(conversation.id, creating);
    }
    try {
      return await creating;
    } finally {
      if (this.creating.get(conversation.id) === creating) this.creating.delete(conversation.id);
    }
  }

  private handleEvent(runtime: ConversationRuntime, event: CoordinatorEvent): void {
    if (event.kind === "brainstorm" && event.artifact) this.brainstormArtifacts.set(runtime.conversationId, event.artifact);
    if (event.kind === "agent" && event.event.type === "tool" && event.event.files?.length) {
      for (const conversation of this.options.history.list()) {
        if (conversation.parent?.conversationId !== runtime.conversationId) continue;
        const child = this.runtimes.get(conversation.id);
        if (child && relative(runtime.workDir, child.workDir) === "") child.coordinator.recordPeerFiles(event.agent, event.event.files);
      }
    }
    const current = this.runtimes.get(this.options.history.currentId) === runtime;
    for (const listener of this.eventListeners) listener(runtime, event, current);
    const used = this.toolUse.get(runtime.conversationId) ?? {};
    if (event.kind === "agent") {
      if (event.event.type === "turn_started") used[event.agent] = false;
      if (event.event.type === "tool") used[event.agent] = true;
      this.toolUse.set(runtime.conversationId, used);
    }
    if (current && this.options.isCurrentProject()) return;
    const conversationTitle =
      this.options.history.list().find(c => c.id === runtime.conversationId)?.title ??
      (this.options.history.currentId === runtime.conversationId ? this.options.history.current.title : undefined);
    const base = { projectRoot: this.options.projectRoot, conversationTitle };
    if (event.kind === "question") this.options.notifyAgent({ ...base, kind: "question", agent: event.agent });
    else if (event.kind === "brainstorm" && event.phase === "human") this.options.notifyAgent({ ...base, kind: "yourTurn" });
    else if (event.kind === "notice") {
      if (event.limitHold) {
        const key = `${runtime.conversationId}:${event.limitHold.agent}`;
        clearTimeout(this.pendingFailure.get(key));
        this.pendingFailure.delete(key);
      }
      this.options.notifyAgent(
        event.limitHold
          ? { ...base, kind: "limitHold", agent: event.limitHold.agent, time: event.limitHold.time }
          : { ...base, kind: "notice", line: event.text },
      );
    } else if (event.kind === "agent" && event.event.type === "error")
      this.options.notifyAgent({ ...base, kind: "error", agent: event.agent, line: event.event.message });
    else if (event.kind === "agent" && event.event.type === "turn") {
      if (event.handoff) return;
      const status = event.event.result.status;
      const input: NotificationInput = { ...base, kind: status === "completed" ? (used[event.agent] ? "work" : "reply") : status, agent: event.agent };
      if (status !== "failed") this.options.notifyAgent(input);
      else {
        const key = `${runtime.conversationId}:${event.agent}`;
        clearTimeout(this.pendingFailure.get(key));
        const timer = setTimeout(() => {
          this.pendingFailure.delete(key);
          this.options.notifyAgent(input);
        }, 0);
        timer.unref?.();
        this.pendingFailure.set(key, timer);
      }
    }
  }
}
