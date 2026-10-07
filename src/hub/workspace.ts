// 1 つの project の会話ごとに Coordinator を持ち、複数の会話を並列に動かす（DESIGN.md §28 D1）。
// 人が見ている会話（今の会話）は 1 つ。会話を切り替えても、前の会話の Agent は止めない
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Coordinator } from "../coordinator/coordinator.js";
import type { RecoveryState, ConversationRecovery } from "../project/recovery-store.js";
import type { CoordinatorEvent, EventBus } from "../coordinator/event-bus.js";
import { t } from "../i18n/i18n.js";
import type { Conversation, ConversationHistory } from "../project/conversation-history.js";
import type { WorktreeResult } from "../project/worktree.js";

const NOTICE_TITLE_LENGTH = 30;

// 会話 1 つ分の実行環境（Event Bus・Coordinator・Agent・MCP server 等）
export interface ConversationRuntime {
  readonly conversationId: string;
  readonly workDir: string;
  readonly bus: EventBus;
  readonly coordinator: Coordinator;
  close(): Promise<void>;
}

export type ConversationActivity = "busy" | "idle" | "stopped";

export type RuntimeEventListener = (runtime: ConversationRuntime, event: CoordinatorEvent, current: boolean) => void;

export interface WorkspaceOptions {
  notify(text: string, level: "info" | "warn"): void;
  history: ConversationHistory;
  projectRoot: string;
  createRuntime: (conversation: Conversation) => Promise<ConversationRuntime>;
  createWorktree: (projectRoot: string, name: string) => Promise<WorktreeResult>;
}

export class Workspace {
  private readonly detach = new Map<string, () => void>();
  private readonly runtimes = new Map<string, ConversationRuntime>();
  private readonly eventListeners: RuntimeEventListener[] = [];
  private readonly switchListeners: Array<(runtime: ConversationRuntime) => void> = [];
  private readonly runtimeListeners: Array<(runtime: ConversationRuntime) => void> = [];
  private readonly recoveryListeners: Array<() => void> = [];

  constructor(private readonly options: WorkspaceOptions) {}

  async init(): Promise<void> {
    await this.ensure(this.options.history.current);
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

  allRuntimes(): ConversationRuntime[] { return [...this.runtimes.values()]; }

  recoveryConversations(): Record<string, ConversationRecovery> {
    const valid = new Set([...this.options.history.list().map(({ id }) => id), this.options.history.currentId]);
    return Object.fromEntries([...this.runtimes.entries()].filter(([id]) => valid.has(id))
      .map(([id, runtime]) => [id, runtime.coordinator.recoveryState()]));
  }

  async restore(state: RecoveryState): Promise<void> {
    const valid = new Map(this.options.history.list().map((conversation) => [conversation.id, conversation]));
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
  async startNew({ worktree = false }: { worktree?: boolean } = {}): Promise<string | undefined> {
    if (worktree) {
      const created = await this.options.createWorktree(this.options.projectRoot, randomUUID());
      if (!created.ok) return created.error;
      this.options.history.startNew(created.worktree);
    } else {
      this.options.history.startNew();
    }
    this.notifySwitch(await this.ensure(this.options.history.current));
    return undefined;
  }

  // runtime が無い会話は undefined（保存のみ）
  activity(conversationId: string): ConversationActivity | undefined {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return undefined;
    const statuses = runtime.coordinator.status().map((agent) => agent.status);
    if (statuses.includes("busy") || statuses.includes("starting")) return "busy";
    return statuses.includes("idle") ? "idle" : "stopped";
  }

  // 同じ作業場所で、今の会話以外の Agent が作業中か（worktree を勧めるため）
  busyElsewhereInSameDir(): boolean {
    const current = this.current;
    return [...this.runtimes.values()].some((runtime) =>
      runtime !== current && runtime.workDir === current.workDir && this.activity(runtime.conversationId) === "busy");
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.close()));
  }

  async restart(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    for (const detach of this.detach.values()) detach();
    this.detach.clear();
    this.runtimes.clear();
    const conversations = [...this.options.history.list(), this.options.history.current];
    for (const id of ids) {
      const conversation = conversations.find((item) => item.id === id);
      if (conversation) await this.ensure(conversation);
    }
    this.notifySwitch(this.current);
    await Promise.all(this.allRuntimes().filter(runtime => existsSync(runtime.workDir)).map((runtime) => runtime.coordinator.start()));
  }

  private notifySwitch(runtime: ConversationRuntime): void {
    for (const listener of this.switchListeners) listener(runtime);
  }

  private async ensure(conversation: Conversation): Promise<ConversationRuntime> {
    const existing = this.runtimes.get(conversation.id);
    if (existing) return existing;
    const runtime = await this.options.createRuntime(conversation);
    this.runtimes.set(conversation.id, runtime);
    const historyDetach = this.options.history.attach(runtime.bus, conversation.id);
    const eventDetach = runtime.bus.subscribe((event) => this.handleEvent(runtime, event));
    const recoveryDetach = runtime.coordinator.onRecoveryChange(() => {
      for (const listener of this.recoveryListeners) listener();
    });
    this.detach.set(conversation.id, () => { historyDetach(); eventDetach(); recoveryDetach(); });
    for (const listener of this.runtimeListeners) listener(runtime);
    return runtime;
  }

  private handleEvent(runtime: ConversationRuntime, event: CoordinatorEvent): void {
    const current = this.runtimes.get(this.options.history.currentId) === runtime;
    for (const listener of this.eventListeners) listener(runtime, event, current);
    if (current || event.kind !== "agent" || event.event.type !== "turn") return;
    // 裏で動いている会話のターンが終わったら、toast で知らせる
    const title = this.options.history.list().find((c) => c.id === runtime.conversationId)?.title ?? runtime.conversationId;
    this.options.notify(
      t("notice.background", { title: title.slice(0, NOTICE_TITLE_LENGTH), agent: event.agent, status: event.event.result.status }),
      event.event.result.status === "completed" ? "info" : "warn",
    );
  }
}
