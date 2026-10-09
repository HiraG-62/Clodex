// Agent 間の routing と lifecycle を決定論的に行う（DESIGN.md §3.9, §12）
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { askUserSchema, answersSchema, type AskUserResult, type PendingQuestion } from "../protocol/questions.js";
import {
  AGENT_IDS, type AgentAdapter, type AgentEvent, type AgentId, type AgentStatus, type PermissionLevel, type SubagentState, type TurnResult,
} from "../agents/agent-adapter.js";
import { resolveSpecFile } from "../project/spec-file.js";
import { changedSections } from "../context/spec-sections.js";
import { buildEnvelope } from "../context/context-resolver.js";
import { CONTEXT_INSTRUCTION } from "../context/conversation-instruction.js";
import { t } from "../i18n/i18n.js";
import { languageReminder, type Language } from "../context/language.js";
import { createMessage, MAX_BODY_LENGTH, type AgentMessage, type CreateMessageResult } from "../protocol/messages.js";
import { AgentMailbox } from "./agent-mailbox.js";
import { BudgetManager, humanBudgetError, type BudgetLimits } from "./budget-manager.js";
import { DEFAULT_USAGE_ALERT, UsageMonitor, limitResetAt, type UsageAlert, type UsageSnapshot } from "./usage-monitor.js";
import type { EventBus } from "./event-bus.js";
import { modelLabel, type ModelCatalog, type StartupProbe } from "../agents/startup-probe.js";
import type { ConversationRecovery } from "../project/recovery-store.js";

// 起動時の Agent の設定（DESIGN.md §9 Agent の設定の保存）
export interface AgentStartSettings {
  permission?: PermissionLevel;
  model?: string;
  effort?: string;
}

// 配送待ちの人間の入力（取り消し・編集の対象。DESIGN.md §28 v0.3 A）
export interface PendingInput {
  id: string;
  agent: AgentId;
  text: string;
}

export interface PendingMessage {
  id: string;
  agent: AgentId;
  from: AgentId;
  type: AgentMessage["type"];
  taskId: string;
  text: string;
}

const QUESTION_ID_PREFIX = "q_";
const QUESTION_HEADER_LENGTH = 80;
const INPUT_ID_PREFIX = "in";
const PREVIEW_LENGTH = 40;
export const RECOVERY_CONTINUE = "[Clodex] Clodex restarted and your previous turn was interrupted. Continue the task you were working on.";
// solo: Agent 同士のやり取りを止める。"free" は人の送り先を固定しない（DESIGN.md §11 Solo）
export type SoloMode = "free" | AgentId;
const SOLO_REMINDER = "[Clodex] Solo mode: do not use send_message. Do all the work yourself.";
const SOLO_RELEASED_NOTE = "[Clodex] Solo mode is off. Delegate to the other agent with send_message as your role says, and reply to requests with send_message.";
const SOLO_REJECTED = "solo mode: the other agent is not available. Do the work yourself.";
// 作業を頼む message は、配送したターンが失敗したら一度だけ送り直し、それでも失敗したら送信元に引き取らせる（DESIGN.md §12 配送ルール）
const RETRIED_TYPES: ReadonlySet<AgentMessage["type"]> = new Set(["DELEGATE", "REVIEW_REQUEST", "QUESTION"]);
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_LIMIT_RESUME_MARGIN_MS = 60_000;
const MS_PER_SECOND = 1000;
const LIMIT_CONTINUE = "[Clodex] Your usage limit has reset. Continue the task you were working on.";
const MAX_DELIVERY_ATTEMPTS = 2;
const ERROR_LINE_LENGTH = 200;
const HUMAN_CONTEXT_LIMIT = 5;
const HUMAN_CONTEXT_LENGTH = 300;
const LAST_ACTIONS_LIMIT = 5;
const OTHER_AGENT: Record<AgentId, AgentId> = { claude: "codex", codex: "claude" };
const HANDOFF_ACTION: Partial<Record<AgentMessage["type"], string>> = {
  DELEGATE: "Implement it yourself",
  REVIEW_REQUEST: "Review the changes yourself",
  QUESTION: "Decide it yourself",
};
const handoffFallback = (message: AgentMessage, error: string) =>
  `[Clodex] Your ${message.type} ${message.id} to ${message.to} failed twice: ${error}. ` +
  `Do not send it again. ${HANDOFF_ACTION[message.type] ?? "Do the work yourself"} and continue the task.`;
const preview = (text: string) => (text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text);

export interface CoordinatorOptions {
  permissionLocked?: () => boolean;
  canStart?: () => boolean;
  projectRoot: string;
  agents: Record<AgentId, AgentAdapter>;
  bus: EventBus;
  mcpUrlFor: (agent: AgentId) => string;
  // 起動のたびに呼ぶ（/role で変えた役割を次の起動に反映する。DESIGN.md §28 E）
  instructions?: (agent: AgentId) => string | undefined;
  createMessageId?: () => string;
  limits?: BudgetLimits;
  settings?: Partial<Record<AgentId, AgentStartSettings>>;
  // 人が読む文章の言語。Task envelope に添える（DESIGN.md §13 Language）
  language?: Language | (() => Language);
  usageAlert?: Partial<UsageAlert>;
  modelCatalog?: () => ModelCatalog;
  // clodex --resume: 各 Agent の最初の起動で継続する session（DESIGN.md §18）
  resumeSessionIds?: Partial<Record<AgentId, string>>;
  // 今の会話の solo。会話の保存が持つので、毎回読む
  solo?: () => SoloMode | undefined;
  soloReleased?: (agent: AgentId) => boolean;
  consumeSoloReleased?: (agent: AgentId) => boolean;
  // 作業を頼む message の配送が失敗してから送り直すまでの待ち（テスト用に短くできる）
  retryDelayMs?: number;
  // 上限で止まった後、リセット時刻からどれだけ待って再開するか（テスト用に短くできる）
  limitResumeMarginMs?: number;
}

export class Coordinator {
  private readonly mailboxes: Record<AgentId, AgentMailbox>;
  private readonly budget: BudgetManager;
  private readonly usage: UsageMonitor;
  private inputSeq = 0;
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly repliedRequests = new Set<string>();
  // 宛先ごと・設計書の実パスごとに、前回渡した中身（DESIGN.md §13 Spec の差分）
  private readonly specSnapshots = new Map<string, string>();
  private readonly liveUsage = new Set<AgentId>();
  private readonly subagents: Record<AgentId, SubagentState[]> = { claude: [], codex: [] };
  private readonly humanContext: Record<AgentId, { entries: Array<{ to: AgentId; text: string }>; extra: number }> = {
    claude: { entries: [], extra: 0 }, codex: { entries: [], extra: 0 },
  };
  private readonly pendingNotices: Record<AgentId, string[]> = { claude: [], codex: [] };
  private readonly turnWork: Partial<Record<AgentId, { plan?: string; actions: string[]; files: Set<string> }>> = {};
  private readonly holdContext: Partial<Record<AgentId, { peerFiles: Set<string> }>> = {};
  private readonly recoveryListeners = new Set<() => void>();
  private stoppingRecovery: ConversationRecovery | undefined;

  onRecoveryChange(listener: () => void): () => void {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  }

  private notifyRecoveryChange(): void {
    if (this.stoppingRecovery) return;
    for (const listener of this.recoveryListeners) listener();
  }

  recoveryState(): ConversationRecovery {
    if (this.stoppingRecovery) return this.stoppingRecovery;
    const interrupted = AGENT_IDS.filter((id) => this.mailboxes[id].activeSending || this.mailboxes[id].holding || this.options.agents[id].status === "busy");
    const lastWork: NonNullable<ConversationRecovery["lastWork"]> = {};
    for (const id of interrupted) {
      const work = this.turnWork[id];
      if (work && (work.plan || work.actions.length)) lastWork[id] = { ...(work.plan ? { plan: work.plan } : {}), actions: [...work.actions] };
    }
    return {
      questions: this.pendingQuestions(),
      interrupted,
      queue: { claude: this.mailboxes.claude.recoveryQueue, codex: this.mailboxes.codex.recoveryQueue },
      ...(Object.keys(lastWork).length ? { lastWork } : {}),
    };
  }

  restore(state: ConversationRecovery): void {
    for (const question of state.questions ?? []) this.questions.set(question.id, question);
    for (const id of AGENT_IDS) this.mailboxes[id].pause();
    for (const id of state.interrupted) {
      if (this.mailboxes[id].sessionId) void this.mailboxes[id].enqueue(`${RECOVERY_CONTINUE}${this.recoveryWorkNote(state.lastWork?.[id])}`, { suffix: this.reminder });
    }
    for (const id of AGENT_IDS) {
      for (const item of state.queue[id]) {
        if (item.kind === "input") {
          void this.mailboxes[id].enqueue(item.text, {
            inputId: `${INPUT_ID_PREFIX}${++this.inputSeq}`, images: item.images,
            suffix: this.inputSuffix(item.context), ...(item.context ? { context: true } : {}),
          });
        } else {
          this.budget.restore(item.message);
          void this.deliver(item.message);
        }
      }
    }
    const queued = AGENT_IDS.reduce((total, id) => total + state.queue[id].length, 0);
    this.options.bus.publish({ kind: "notice", text: t("notice.recovered", { interrupted: state.interrupted.length, queued }) });
    for (const id of AGENT_IDS) this.mailboxes[id].resume();
  }

  constructor(private readonly options: CoordinatorOptions) {
    const { agents, bus, projectRoot, mcpUrlFor, instructions, limits, settings } = options;
    this.budget = new BudgetManager(limits);
    this.usage = new UsageMonitor(bus, { ...DEFAULT_USAGE_ALERT, ...options.usageAlert });
    for (const id of AGENT_IDS) {
      agents[id].onEvent((event) => {
        if (event.type === "rate_limit") this.liveUsage.add(id);
        if (event.type === "subagents") this.subagents[id] = [...event.running];
        this.recordWork(id, event);
        bus.publish({ kind: "agent", agent: id, event });
        if (event.type !== "turn" || event.result.status !== "failed") return;
        const mailbox = this.mailboxes?.[id];
        if (!mailbox || mailbox.activeSending || mailbox.holding || mailbox.isClosed) return;
        const hold = this.limitHold(id);
        if (hold) mailbox.holdForLimit(hold);
      });
      // 起動前なので値を保持するだけ（次の起動時に使われる）
      const { permission, model, effort } = settings?.[id] ?? {};
      if (permission) void agents[id].setPermission(permission);
      if (model) void agents[id].setModel(model);
      if (effort) void agents[id].setEffort(effort);
    }
    const createMailbox = (id: AgentId) => {
      const resumeSessionId = options.resumeSessionIds?.[id];
      const mcpUrl = mcpUrlFor(id);
      return new AgentMailbox(
        agents[id],
        () => {
          const instruction = instructions?.(id);
          return {
            cwd: projectRoot, mcpUrl,
            ...(instruction ? { instructions: instruction } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
          };
        },
        (message) => bus.publish({ kind: "agent", agent: id, event: { type: "error", message } }),
        () => this.notifyRecoveryChange(),
        () => { if (this.options.canStart?.() === false) throw new Error(t("sandbox.incomplete")); },
        () => this.limitHold(id),
        () => this.deliveryNote(id),
      );
    };
    this.mailboxes = { claude: createMailbox("claude"), codex: createMailbox("codex") };
  }

  private limitHold(id: AgentId): { resumeAt: number; text: string } | undefined {
    const resetAt = limitResetAt(this.usage.snapshot(id));
    if (resetAt === undefined) return undefined;
    const resumeAt = resetAt * MS_PER_SECOND + (this.options.limitResumeMarginMs ?? DEFAULT_LIMIT_RESUME_MARGIN_MS);
    const time = new Date(resumeAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    this.holdContext[id] = { peerFiles: new Set() };
    this.notifyPeerLimit(id, resumeAt);
    this.options.bus.publish({ kind: "notice", text: t("notice.limitHold", { agent: id, time }), limitHold: { agent: id, time } });
    return { resumeAt, text: `${LIMIT_CONTINUE}${this.reminder}` };
  }

  private recordWork(id: AgentId, event: AgentEvent): void {
    if (event.type === "turn_started") this.turnWork[id] = { actions: [], files: new Set() };
    if (event.type === "text") {
      const work = this.turnWork[id];
      if (work) work.plan ??= event.text.split(/\r?\n/, 1)[0];
    }
    if (event.type === "tool") {
      const work = this.turnWork[id];
      if (work) {
        work.actions.push(`${event.name} ${event.input}`.trim());
        if (work.actions.length > LAST_ACTIONS_LIMIT) work.actions.shift();
      }
      for (const file of event.files ?? []) {
        work?.files.add(file);
        this.holdContext[OTHER_AGENT[id]]?.peerFiles.add(file);
      }
    }
    if (["turn_started", "text", "tool", "turn"].includes(event.type)) this.notifyRecoveryChange();
  }

  private recoveryWorkNote(work: NonNullable<ConversationRecovery["lastWork"]>[AgentId]): string {
    if (!work) return "";
    const plan = work.plan ? `Before the restart you were: ${work.plan}.` : "";
    const actions = work.actions.length ? `Last actions:\n${work.actions.map((action) => `- ${action}`).join("\n")}` : "";
    return `\n${[plan, actions].filter(Boolean).join(" ")}`;
  }

  private notifyPeerLimit(id: AgentId, resumeAt: number): void {
    const peer = OTHER_AGENT[id];
    if (this.options.solo?.() || this.options.agents[peer].status === "stopped") return;
    const work = this.turnWork[id];
    const plan = work?.plan ? ` Its last plan: ${work.plan}.` : "";
    const files = work?.files.size ? ` Files it edited in its last turn: ${[...work.files].join(", ")}. Do not edit these files until it resumes.` : "";
    const notice = `[Clodex] ${id} hit its usage limit and resumes at ${new Date(resumeAt).toISOString()}.${plan}${files}`;
    if (this.options.agents[peer].status !== "busy") {
      this.pendingNotices[peer].push(notice);
      return;
    }
    void this.steerWithNotice(peer, notice, randomUUID()).then((sent) => {
      if (!sent) this.pendingNotices[peer].push(notice);
    }).catch(() => { this.pendingNotices[peer].push(notice); });
  }

  setLimits(limits: BudgetLimits): void {
    this.budget.setLimits(limits);
  }

  askUser(agent: AgentId, input: unknown): AskUserResult {
    const parsed = askUserSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const id = `${QUESTION_ID_PREFIX}${randomUUID()}`;
    const question: PendingQuestion = { id, agent, questions: parsed.data.questions };
    this.questions.set(id, question);
    this.options.bus.publish({ kind: "question", ...question });
    this.notifyRecoveryChange();
    return { ok: true, id };
  }

  pendingQuestions(): PendingQuestion[] { return [...this.questions.values()]; }

  answer(id: string, input: unknown): string | undefined {
    const question = this.questions.get(id);
    if (!question) return t("question.missing");
    const parsed = answersSchema.safeParse(input);
    if (!parsed.success || parsed.data.length !== question.questions.length) return t("question.invalid");
    const answers = parsed.data;
    const text = `Answer to your question ${id}:\n` + question.questions.map((item, index) =>
      `- ${item.header ?? item.question.slice(0, QUESTION_HEADER_LENGTH)}: ${answers[index]!.join(", ")}`).join("\n");
    this.questions.delete(id);
    this.options.bus.publish({ kind: "answer", id, agent: question.agent, answers });
    question.questions.forEach((item, index) => this.queueHumanContext(question.agent,
      `${item.header ?? item.question.slice(0, QUESTION_HEADER_LENGTH)}: ${answers[index]!.join(", ")}`));
    void this.mailboxes[question.agent].enqueue(text, { inputId: `${INPUT_ID_PREFIX}${++this.inputSeq}`, suffix: this.reminder });
    this.notifyRecoveryChange();
    return undefined;
  }

  // MCP の send_message から呼ばれる。検証・記録・配送を行い、受理結果を送信元へ返す
  receiveMessage(from: AgentId, input: unknown): CreateMessageResult {
    const { projectRoot, bus, createMessageId } = this.options;
    if (this.options.solo?.()) return { ok: false, error: SOLO_REJECTED };
    const result = createMessage(input, {
      from, repository: projectRoot, ...(createMessageId ? { createId: createMessageId } : {}),
    });
    if (!result.ok) return result;
    const { message } = result;
    let specSnapshot: { key: string; content: string } | undefined;
    if (message.spec !== undefined) {
      const specPath = resolveSpecFile(projectRoot, message.spec);
      if (!specPath) return { ok: false, error: "spec: must be a relative path to an existing regular file inside the project root" };
      specSnapshot = { key: `${message.to}\0${specPath}`, content: readFileSync(specPath, "utf8") };
      const previous = this.specSnapshots.get(specSnapshot.key);
      if (previous !== undefined) message.specChanges = changedSections(previous, specSnapshot.content);
    }

    // 送信元が処理中の message を親として chain を決める（DESIGN.md §14）
    const parent = this.mailboxes[from].current;
    const budgetError = this.budget.admit(message, parent);
    if (budgetError) {
      bus.publish({ kind: "agent", agent: from, event: { type: "error", message: humanBudgetError(budgetError) } });
      return { ok: false, error: budgetError };
    }

    if (parent && RETRIED_TYPES.has(parent.type) && message.to === parent.from) this.repliedRequests.add(parent.id);
    if (specSnapshot) this.specSnapshots.set(specSnapshot.key, specSnapshot.content);
    bus.publish({ kind: "message", message });
    // ACK は記録のみ。配送して Agent を起こさない（DESIGN.md §12, §25）
    if (message.type !== "ACK") void this.deliver(message);
    return result;
  }

  // interrupt: 宛先が送信元からの message を処理中なら、そのターンに足す。足せなければキューに積む（DESIGN.md §28 v0.3 C）
  private async deliver(message: AgentMessage, attempt = 1): Promise<void> {
    const envelope = buildEnvelope(message, this.language);
    const mailbox = this.mailboxes[message.to];
    const steerable = message.interrupt && mailbox.current?.from === message.from;
    if (steerable && await this.steerWithNotice(message.to, envelope, message.id)) return;
    const result = await mailbox.enqueue(envelope, { message });
    const replied = this.repliedRequests.delete(message.id);
    if (RETRIED_TYPES.has(message.type) && result.status === "completed" && result.text.trim() && !replied
      && !mailbox.isClosed && !mailbox.holding) this.autoResult(message, result.text);
    // 上限で待っている宛先は、リセット後に続きを送るので送り直さない
    if (result.status !== "failed" || !RETRIED_TYPES.has(message.type) || mailbox.isClosed || mailbox.holding) return;
    if (attempt < MAX_DELIVERY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS).unref?.());
      if (!mailbox.isClosed) await this.deliver(message, attempt + 1);
      return;
    }
    const sender = this.mailboxes[message.from];
    if (sender.isClosed) return;
    const error = (result.text.split("\n", 1)[0] ?? "").slice(0, ERROR_LINE_LENGTH);
    this.options.bus.publish({ kind: "notice", text: t("notice.handoffFailed", { type: message.type, to: message.to, from: message.from }) });
    void sender.enqueue(handoffFallback(message, error), { inputId: `${INPUT_ID_PREFIX}${++this.inputSeq}`, suffix: this.reminder });
  }

  private autoResult(request: AgentMessage, text: string): void {
    const body = text.length > MAX_BODY_LENGTH ? `${text.slice(0, MAX_BODY_LENGTH - 1)}…` : text;
    const created = createMessage({ to: request.from, type: "RESULT", taskId: request.taskId, replyTo: request.id,
      status: "done", body }, { from: request.to, repository: this.options.projectRoot,
      ...(this.options.createMessageId ? { createId: this.options.createMessageId } : {}) });
    if (!created.ok) return;
    const message: AgentMessage = { ...created.message, auto: true };
    const budgetError = this.budget.admit(message, request);
    if (budgetError) {
      this.options.bus.publish({ kind: "agent", agent: request.to, event: { type: "error", message: humanBudgetError(budgetError) } });
      return;
    }
    this.options.bus.publish({ kind: "message", message });
    void this.deliver(message);
  }

  // @agent!: 実行中なら steer し、そうでなければ通常の送信（DESIGN.md §28 v0.3 C）
  async steerOrSend(id: AgentId, text: string, context = false, shared = false): Promise<"steered" | "queued"> {
    const steerId = randomUUID();
    if (await this.steerWithNotice(id, `${text}${this.inputSuffix(context)}`, steerId)) {
      this.options.bus.publish({ kind: "human", agent: id, text, steer: true, steerId });
      if (!shared) this.queueHumanContext(id, text);
      return "steered";
    }
    void this.sendToAgent(id, text, [], context, shared);
    return "queued";
  }

  private deliveryNote(id: AgentId): string {
    const note = this.peekDeliveryNote(id);
    this.consumeDeliveryNote(id);
    return note;
  }

  private peekDeliveryNote(id: AgentId): string {
    const human = this.humanContext[id];
    const humanNote = human.entries.length
      ? `\n\n[Clodex] Since your last turn, the human said to ${human.entries[0]!.to}:\n${human.entries.map((item) => `- ${this.previewHuman(item.text)}`).join("\n")}${human.extra ? `\n- (+${human.extra} more)` : ""}`
      : "";
    const notices = this.pendingNotices[id].map((notice) => `\n\n${notice}`).join("");
    const edited = [...(this.holdContext[id]?.peerFiles ?? [])];
    const holdNote = edited.length ? `\n\nWhile you were stopped, ${OTHER_AGENT[id]} edited: ${edited.join(", ")}. Check them before continuing.` : "";
    const soloNote = this.options.soloReleased?.(id) ? `\n\n${SOLO_RELEASED_NOTE}` : "";
    return `${soloNote}${humanNote}${notices}${holdNote}`;
  }

  private consumeDeliveryNote(id: AgentId): void {
    if (this.options.soloReleased?.(id)) this.options.consumeSoloReleased?.(id);
    this.humanContext[id] = { entries: [], extra: 0 };
    this.pendingNotices[id] = [];
    delete this.holdContext[id];
  }

  private previewHuman(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > HUMAN_CONTEXT_LENGTH ? `${line.slice(0, HUMAN_CONTEXT_LENGTH)}…` : line;
  }

  private queueHumanContext(to: AgentId, text: string): void {
    const queue = this.humanContext[OTHER_AGENT[to]];
    if (queue.entries.length < HUMAN_CONTEXT_LIMIT) queue.entries.push({ to, text });
    else queue.extra++;
  }

  private async steerWithNotice(id: AgentId, text: string, steerId: string): Promise<boolean> {
    const note = this.peekDeliveryNote(id);
    if (!await this.options.agents[id].steer(`${text}${note}`, steerId)) return false;
    this.consumeDeliveryNote(id);
    return true;
  }

  sendToAgent(id: AgentId, text: string, images: readonly string[] = [], context = false, shared = false): Promise<TurnResult> {
    this.options.bus.publish({ kind: "human", agent: id, text });
    if (!shared) this.queueHumanContext(id, text);
    return this.mailboxes[id].enqueue(text, {
      inputId: `${INPUT_ID_PREFIX}${++this.inputSeq}`, images,
      suffix: this.inputSuffix(context), ...(context ? { context: true } : {}),
    });
  }

  private inputSuffix(context?: boolean): string {
    return `${context ? `\n\n${CONTEXT_INSTRUCTION}` : ""}${this.reminder}`;
  }

  private get language(): Language | undefined {
    const language = this.options.language;
    return typeof language === "function" ? language() : language;
  }

  // 人の入力の末尾に足す solo と言語の行（DESIGN.md §11 Solo・§13 Language）。どちらも無ければ空
  private get reminder(): string {
    const language = this.language;
    const lines = [...(this.options.solo?.() ? [SOLO_REMINDER] : []), ...(language ? [languageReminder(language)] : [])];
    return lines.length ? `\n\n${lines.join("\n")}` : "";
  }

  // 作業中のターンも配送待ちの入力・message も無い（solo の切り替えの条件。DESIGN.md §11 Solo）
  idle(): boolean {
    return AGENT_IDS.every((id) => this.options.agents[id].status !== "busy" && this.mailboxes[id].isIdle);
  }

  // 送った順（ID の連番順）に並べる
  pendingInputs(): PendingInput[] {
    const seq = (id: string) => Number(id.slice(INPUT_ID_PREFIX.length));
    return AGENT_IDS.flatMap((agent) => this.mailboxes[agent].pendingInputs.map((input) => ({ ...input, agent })))
      .sort((a, b) => seq(a.id) - seq(b.id));
  }

  pendingMessages(): PendingMessage[] {
    return AGENT_IDS.flatMap((agent) => this.mailboxes[agent].pendingMessages.map((message) => ({
      id: message.id, agent, from: message.from, type: message.type, taskId: message.taskId, text: message.body,
    })));
  }

  // ID 省略時は最後に送った配送待ちの入力。取り消せなければ undefined
  cancelInput(id?: string): PendingInput | PendingMessage | undefined {
    const target = id
      ? this.pendingInputs().find((input) => input.id === id) ?? this.pendingMessages().find((message) => message.id === id)
      : this.pendingInputs().at(-1);
    if (!target || this.mailboxes[target.agent].cancel(target.id) === undefined) return undefined;
    this.options.bus.publish({ kind: "notice", text: t("notice.canceled", { agent: target.agent, text: preview(target.text) }) });
    return target;
  }

  // 全 Agent の配送が終わるまで待つ。配送中のターンが相手へ message を送ることがあるので、全員が同時に空になるまで繰り返す
  async whenIdle(): Promise<void> {
    while (!AGENT_IDS.every((id) => this.mailboxes[id].isIdle)) {
      await Promise.all(AGENT_IDS.map((id) => this.mailboxes[id].whenIdle()));
    }
  }

  // /resume・/new: targets の Agent を止め、次回はそれぞれ指定の session（無ければ新規）で起動する。拒否したら理由を返す
  async switchSessions(
    sessions: Partial<Record<AgentId, string>>, targets: readonly AgentId[] = AGENT_IDS,
  ): Promise<string | undefined> {
    // 起動中や配送待ちも含めて、受け付けた作業がある Agent は止めない
    const busy = targets.filter((id) => this.options.agents[id].status === "busy" || !this.mailboxes[id].isIdle);
    if (busy.length) return t("reject.busy", { agents: busy.join(", ") });
    for (const id of targets) this.mailboxes[id].pause();
    try {
      await Promise.all(targets.map((id) => this.options.agents[id].stop()));
      for (const id of targets) {
        this.mailboxes[id].switchSession(sessions[id]);
        this.usage.clearContext(id);
      }
    } finally {
      for (const id of targets) this.mailboxes[id].resume();
    }
    return undefined;
  }

  // 省略時は起動中の Agent だけ（停止中の Agent は compact するものが無い）
  compact(id?: AgentId): Promise<TurnResult[]> {
    const targets = id ? [id] : AGENT_IDS.filter((agent) => this.options.agents[agent].status !== "stopped");
    return Promise.all(targets.map((target) => this.mailboxes[target].enqueueCompact()));
  }

  // Agent 指定なしは、Agent 間のやり取りも止める: 配送待ちの formal message を破棄し、chain を閉じる
  async interrupt(id?: AgentId): Promise<void> {
    if (!id) this.stopExchanges();
    const targets = id ? [id] : AGENT_IDS;
    for (const target of targets) {
      this.mailboxes[target].releaseHold();
      delete this.holdContext[target];
    }
    await Promise.all(targets.map((target) => this.options.agents[target].interrupt()));
  }

  private stopExchanges(): void {
    const discarded = AGENT_IDS.flatMap((agent) => this.mailboxes[agent].discardMessages());
    const processing = AGENT_IDS.flatMap((agent) => this.mailboxes[agent].current ?? []);
    this.budget.closeChains([...discarded, ...processing]);
    if (discarded.length) {
      this.options.bus.publish({ kind: "notice", text: t("notice.discarded", { count: discarded.length }) });
    }
  }

  async setPermission(level: PermissionLevel, id?: AgentId): Promise<void> {
    if (this.options.permissionLocked?.()) throw new Error(t("sandbox.permission"));
    const targets = id ? [id] : AGENT_IDS;
    await Promise.all(targets.map((target) => this.options.agents[target].setPermission(level)));
  }

  async setModel(model: string, id: AgentId): Promise<TurnResult | void> {
    return this.mailboxes[id].enqueueModel(model);
  }

  async setEffort(level: string, id?: AgentId): Promise<TurnResult | void> {
    if (id) return this.mailboxes[id].enqueueEffort(level);
    const results = await Promise.all(AGENT_IDS.map((agent) => this.mailboxes[agent].enqueueEffort(level)));
    return results.find((result) => result.status === "failed") ?? results[0];
  }

  status(): Array<{
    id: AgentId; status: AgentStatus; sessionId: string | undefined; permission: PermissionLevel;
    model: string | undefined; modelLabel: string; effort: string | undefined; models: ModelCatalog[AgentId]; usage: UsageSnapshot; subagents: SubagentState[]; holdUntil?: string;
  }> {
    return AGENT_IDS.map((id) => {
      const { status, permission, model, effort } = this.options.agents[id];
      const models = this.options.modelCatalog?.()[id] ?? [];
      const holdUntil = this.mailboxes[id].holdUntil;
      return { id, status, sessionId: this.mailboxes[id].sessionId, permission, model, modelLabel: modelLabel(model, models), effort, models, usage: this.usage.snapshot(id), subagents: [...this.subagents[id]], ...(holdUntil ? { holdUntil } : {}) };
    });
  }

  applyStartupUsage(usage: StartupProbe["usage"]): void {
    for (const id of AGENT_IDS) {
      const event = usage[id];
      if (event && !this.liveUsage.has(id)) this.options.bus.publish({ kind: "agent", agent: id, event });
    }
  }

  async start(): Promise<void> {
    await Promise.all(AGENT_IDS.map((id) => this.mailboxes[id].ensureRunning()));
  }

  async stop(): Promise<void> {
    this.stoppingRecovery = this.recoveryState();
    for (const id of AGENT_IDS) this.mailboxes[id].close();
    await Promise.all(AGENT_IDS.map((id) => this.options.agents[id].stop()));
  }
}
