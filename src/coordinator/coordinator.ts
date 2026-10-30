// Agent 間の routing と lifecycle を決定論的に行う（DESIGN.md §3.9, §12）
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AGENT_IDS,
  type AgentAdapter,
  type AgentId,
  type AgentStatus,
  type PermissionLevel,
  type SubagentState,
  type TurnResult,
} from "../agents/agent-adapter.js";
import { AGENT_META, agentRecord, peersOf } from "../agents/agent-meta.js";
import { type ModelCatalog, modelLabel } from "../agents/model-catalog.js";
import type { StartupProbe } from "../agents/startup-probe.js";
import type { ClodexConfig } from "../config/config.js";
import { buildEnvelope } from "../context/context-resolver.js";
import { CONTEXT_INSTRUCTION } from "../context/conversation-instruction.js";
import { type Language, languageReminder } from "../context/language.js";
import { changedSections } from "../context/spec-sections.js";
import { t } from "../i18n/i18n.js";
import type { ConversationRecovery } from "../project/recovery-store.js";
import { resolveSpecFile } from "../project/spec-file.js";
import { type AgentMessage, type CreateMessageResult, createMessage, FOLLOWUP_TYPES, MAX_BODY_LENGTH } from "../protocol/messages.js";
import type { AskUserResult, PendingQuestion } from "../protocol/questions.js";
import { AgentMailbox, type PreparedSend } from "./agent-mailbox.js";
import { type BrainstormConfig, type BrainstormResponse, roundPrompt, summaryPrompt } from "./brainstorm.js";
import { type BudgetLimits, BudgetManager, humanBudgetError } from "./budget-manager.js";
import { DeliveryNotes } from "./delivery-notes.js";
import type { EventBus } from "./event-bus.js";
import { QuestionStore } from "./question-store.js";
import { createHandoffPath, handoffInstruction, handoffNotice, hasHandoffDocument } from "./session-handoff.js";
import { runSpecCheck } from "./spec-check.js";
import { type ConversationTaskMetrics, TaskMetricsRecorder, TaskMetricsStore } from "./task-metrics.js";
import { DEFAULT_USAGE_ALERT, limitResetAt, type ThreadTokenWarn, type UsageAlert, UsageMonitor, type UsageSnapshot } from "./usage-monitor.js";
import { WorkBaselines } from "./work-baseline.js";
import { WorkRecorder } from "./work-recorder.js";

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
  fresh?: true;
}

export type SteerQueuedResult = { ok: true } | { ok: false; reason: "missing" | "idle" | "holding" | "unsupported" | "fresh" | "rejected"; agent?: AgentId };

const INPUT_ID_PREFIX = "in";
export const RECOVERY_CONTINUE = "[Clodex] Clodex restarted and your previous turn was interrupted. Continue the task you were working on.";
// solo: Agent 同士のやり取りを止める。"free" は人の送り先を固定しない（DESIGN.md §11 Solo）
export type SoloMode = "free" | AgentId;
const SOLO_REMINDER = "[Clodex] Solo mode: do not use send_message. Do all the work yourself.";
const SOLO_REJECTED = "solo mode: the other agents are not available. Do the work yourself.";
const BRAINSTORM_REJECTED = "brainstorm mode: do not use send_message";
const STEER_IMAGE_INSTRUCTION = "[Clodex] Attached images (read them with your tools):";
// 作業を頼む message は、配送したターンが失敗したら一度だけ送り直し、それでも失敗したら送信元に引き取らせる（DESIGN.md §12 配送ルール）
const RETRIED_TYPES: ReadonlySet<AgentMessage["type"]> = new Set(["DELEGATE", "REVIEW_REQUEST", "QUESTION", "FIX", "ADD"]);
const HANDOFF_REQUEST_TYPES: ReadonlySet<AgentMessage["type"]> = new Set(["DELEGATE", "REVIEW_REQUEST", "QUESTION"]);
export type RequestState = "active" | "queued" | "finished";
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_LIMIT_RESUME_MARGIN_MS = 60_000;
const MS_PER_SECOND = 1000;
const LIMIT_CONTINUE = "[Clodex] Your usage limit has reset. Continue the task you were working on.";
const DENIED_CONTINUE =
  "Do not retry them. Continue with what you can, give your answer from what you already have, and say which permission is missing if needed.";
const MAX_DELIVERY_ATTEMPTS = 2;
const RETRY_NOTE =
  "[Clodex] Retry: your previous attempt at this message failed partway. Check the current state of the files before continuing; do not redo finished work.";
const ERROR_LINE_LENGTH = 200;
const SPEC_HASH_LENGTH = 12;
const HANDOFF_ACTION: Partial<Record<AgentMessage["type"], string>> = {
  DELEGATE: "Implement it yourself",
  REVIEW_REQUEST: "Review the changes yourself",
  QUESTION: "Decide it yourself",
};
const handoffFallback = (message: AgentMessage, error: string) =>
  `[Clodex] Your ${message.type} ${message.id} to ${message.to} failed twice: ${error}. ` +
  `Do not send it again. ${HANDOFF_ACTION[message.type] ?? "Do the work yourself"} and continue the task.`;

export interface CoordinatorOptions {
  usageNotifications?: Set<string>;
  verify?: ClodexConfig["verify"];
  specSections?: ClodexConfig["specSections"];
  specCheck?: string;
  artifactsDir?: string;
  conversationId?: string;
  metricsStore?: TaskMetricsStore;
  brainstorm?: BrainstormConfig;
  brainstormArtifactsDir?: string;
  brainstormPrimary?: AgentId;
  brainstormComplete?: boolean;
  permissionLocked?: () => boolean;
  canStart?: () => boolean;
  onAgentStart?: () => void;
  projectRoot: string;
  agents: Record<AgentId, AgentAdapter>;
  bus: EventBus;
  mcpUrlFor: (agent: AgentId) => string;
  // 起動のたびに呼ぶ（/role で変えた役割を次の起動に反映する。DESIGN.md §28 E）
  instructions?: (agent: AgentId) => string | undefined;
  createMessageId?: () => string;
  knownMessages?: readonly AgentMessage[];
  knownInputIds?: readonly string[];
  limits?: BudgetLimits;
  settings?: Partial<Record<AgentId, AgentStartSettings>>;
  freshThread?: Partial<Record<"DELEGATE" | "REVIEW_REQUEST", boolean>>;
  startParallel?: (message: AgentMessage) => Promise<{ thread: string } | { error: string }>;
  discardParallel?: (thread: string) => Promise<void>;
  deliverToThread?: (thread: string, message: AgentMessage) => Promise<void>;
  threadRequestState?: (thread: string, requestId: string, to: AgentId) => RequestState;
  forwardToParent?: (message: AgentMessage) => CreateMessageResult;
  forwardFailureToParent?: (message: AgentMessage, error: string) => void;
  parallelParent?: { from: AgentId; to: AgentId; messageId: string };
  clearSession?: (agent: AgentId) => void;
  // 人が読む文章の言語。Task envelope に添える（DESIGN.md §13 Language）
  language?: Language | (() => Language);
  usageAlert?: Partial<UsageAlert>;
  threadTokenWarn?: ThreadTokenWarn;
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
  private readonly metricsStore: TaskMetricsStore;
  private readonly metrics: TaskMetricsRecorder;
  private readonly mailboxes: Record<AgentId, AgentMailbox>;
  private readonly budget: BudgetManager;
  private readonly usage: UsageMonitor;
  private inputSeq = 0;
  private readonly turnInputs: Partial<Record<AgentId, string[]>> = {};
  private readonly questions = new QuestionStore();
  private readonly workRecorder = new WorkRecorder();
  private readonly workBaselines: WorkBaselines;
  private readonly requestSpecs = new Map<string, string>();
  private readonly specChecks = new Map<string, Promise<void>>();
  private readonly deliveryNotes: DeliveryNotes;
  private readonly repliedRequests = new Set<string>();
  private readonly messages = new Map<string, AgentMessage>();
  private readonly threadSenders = new Map<string, AgentId>();
  private readonly handoffTurns: Partial<Record<AgentId, boolean>> = {};
  private readonly sessionHandoffs = new Set<AgentId>();
  private parallelResultPending = false;
  private parallelStopWaiting = false;
  // 宛先ごと・設計書の実パスごとに、前回渡した中身（DESIGN.md §13 Spec の差分）
  private readonly specSnapshots = new Map<string, { content: string; sessionId: string | undefined }>();
  private readonly liveUsage = new Set<AgentId>();
  private readonly subagents: Record<AgentId, SubagentState[]> = agentRecord(() => []);
  private readonly backgroundTasks: Record<AgentId, SubagentState[]> = agentRecord(() => []);
  private readonly recoveryListeners = new Set<() => void>();
  private stoppingRecovery: ConversationRecovery | undefined;
  private brainstormPhase: "idle" | "round" | "summary" | "done" | "stopped" = "idle";
  private brainstormRound = 0;
  private brainstormHuman: Array<{ id: string; agent: AgentId; targets: readonly AgentId[]; text: string }> = [];
  private brainstormInFlightHuman: typeof this.brainstormHuman = [];
  private brainstormInterrupted = false;
  private readonly brainstormAbort = new AbortController();

  get brainstormState(): { phase: string; round: number; total: number } | undefined {
    const config = this.options.brainstorm;
    return config ? { phase: this.brainstormPhase, round: this.brainstormRound, total: config.rounds } : undefined;
  }

  addBrainstormInput(agent: AgentId, text: string, targets: readonly AgentId[] = [agent]): void {
    const id = `${INPUT_ID_PREFIX}${++this.inputSeq}`;
    this.brainstormHuman.push({ id, agent, targets, text });
    this.options.bus.publish({ kind: "human", agent, text, inputId: id, nextRound: true });
    this.notifyRecoveryChange();
  }

  private takeBrainstormInput(): string[] {
    this.brainstormInFlightHuman = this.brainstormHuman.splice(0);
    this.notifyRecoveryChange();
    return this.brainstormInFlightHuman.map(({ text }) => text);
  }

  private finishBrainstormInput(completed: boolean): void {
    if (!completed) this.brainstormHuman.unshift(...this.brainstormInFlightHuman);
    this.brainstormInFlightHuman = [];
    this.notifyRecoveryChange();
  }

  private releaseBrainstormInput(): void {
    for (const input of [...this.brainstormInFlightHuman.splice(0), ...this.brainstormHuman.splice(0)]) {
      this.options.bus.publish({ kind: "brainstormReleased", inputId: input.id });
      for (const target of input.targets) {
        const inputId = target === input.agent ? input.id : `${INPUT_ID_PREFIX}${++this.inputSeq}`;
        this.detach(this.mailboxes[target].enqueue(input.text, { inputId, suffix: this.reminder }), target);
      }
    }
    this.notifyRecoveryChange();
  }

  async startBrainstorm(): Promise<void> {
    const config = this.options.brainstorm;
    if (!config || this.brainstormPhase !== "idle") return;
    const responses: BrainstormResponse[] = [];
    for (let round = 1; round <= config.rounds; round++) {
      if (this.brainstormInterrupted) break;
      this.brainstormPhase = "round";
      this.brainstormRound = round;
      this.options.bus.publish({ kind: "brainstorm", phase: "round", round, total: config.rounds });
      this.notifyRecoveryChange();
      const human = this.takeBrainstormInput();
      const turns = AGENT_IDS.map(id =>
        this.mailboxes[id].enqueue(
          roundPrompt(
            config,
            round,
            id,
            responses.filter(response => response.round === round - 1 && peersOf(id).includes(response.agent)),
            human,
          ),
          { suffix: this.reminder, signal: this.brainstormAbort.signal },
        ),
      );
      const results = await Promise.all(turns);
      const completed = !this.brainstormInterrupted && results.every(result => result.status === "completed");
      this.finishBrainstormInput(completed);
      if (!completed) break;
      for (const [index, id] of AGENT_IDS.entries()) responses.push({ round, agent: id, text: results[index]?.text ?? "" });
    }
    if (responses.length === config.rounds * AGENT_IDS.length && !this.brainstormInterrupted) {
      this.brainstormPhase = "summary";
      this.options.bus.publish({ kind: "brainstorm", phase: "summary", total: config.rounds });
      this.notifyRecoveryChange();
      const primary = this.options.brainstormPrimary ?? "claude";
      const result = await this.mailboxes[primary].enqueue(summaryPrompt(config, responses, this.takeBrainstormInput()), {
        suffix: this.reminder,
        signal: this.brainstormAbort.signal,
      });
      this.finishBrainstormInput(result.status === "completed" && !this.brainstormInterrupted);
      if (result.status === "completed" && !this.brainstormInterrupted) {
        const dir = this.options.brainstormArtifactsDir;
        if (dir) {
          try {
            mkdirSync(dir, { recursive: true });
            const path = join(dir, `brainstorm-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
            writeFileSync(path, `${result.text}\n`, "utf8");
            this.options.bus.publish({ kind: "brainstorm", phase: "summary", total: config.rounds, artifact: path });
          } catch (error) {
            this.options.bus.publish({ kind: "notice", text: error instanceof Error ? error.message : String(error), level: "warn" });
            this.brainstormPhase = "stopped";
            this.notifyRecoveryChange();
            return;
          }
        }
        this.brainstormPhase = "done";
        this.notifyRecoveryChange();
        return;
      }
    }
    this.brainstormPhase = "stopped";
    this.releaseBrainstormInput();
    this.options.bus.publish({ kind: "notice", text: t("notice.brainstormStopped"), level: "warn" });
    this.notifyRecoveryChange();
  }

  private detach(promise: Promise<unknown>, agent?: AgentId): void {
    void promise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (agent) this.options.bus.publish({ kind: "agent", agent, event: { type: "error", message } });
      else this.options.bus.publish({ kind: "notice", text: message });
    });
  }

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
    const interrupted = AGENT_IDS.filter(id => this.mailboxes[id].activeSending || this.mailboxes[id].holding || this.options.agents[id].status === "busy");
    const queue = agentRecord(id => this.mailboxes[id].recoveryQueue);
    for (const input of [...this.brainstormInFlightHuman, ...this.brainstormHuman]) {
      for (const target of input.targets) {
        queue[target].push({ kind: "input", ...(target === input.agent ? { id: input.id } : {}), text: input.text, brainstorm: true });
      }
    }
    return {
      ...this.workRecorder.recoveryState(this.pendingQuestions(), interrupted, queue),
      ...(this.options.brainstorm ? { brainstormPhase: this.brainstormPhase } : {}),
    };
  }

  restore(state: ConversationRecovery): void {
    const interruptedBrainstorm = Boolean(
      this.options.brainstorm && !this.options.brainstormComplete && state.brainstormPhase !== "stopped" && state.brainstormPhase !== "done",
    );
    if (this.options.brainstorm && !this.options.brainstormComplete) {
      this.brainstormPhase = "stopped";
      if (interruptedBrainstorm) this.options.bus.publish({ kind: "notice", text: t("notice.brainstormStopped"), level: "warn" });
    }
    this.questions.restore(state.questions ?? []);
    for (const agent of AGENT_IDS) {
      for (const item of state.queue[agent]) {
        if (item.kind === "input" && item.id) this.rememberInputId(item.id);
      }
    }
    for (const id of AGENT_IDS) this.mailboxes[id].pause();
    for (const id of interruptedBrainstorm ? [] : state.interrupted) {
      if (this.mailboxes[id].sessionId)
        this.detach(
          this.mailboxes[id].enqueue(`${RECOVERY_CONTINUE}${this.workRecorder.recoveryWorkNote(state.lastWork?.[id])}`, { suffix: this.reminder }),
          id,
        );
    }
    for (const id of AGENT_IDS) {
      for (const item of state.queue[id]) {
        if (item.kind === "input") {
          if (item.brainstorm && item.id) this.options.bus.publish({ kind: "brainstormReleased", inputId: item.id });
          this.detach(
            this.mailboxes[id].enqueue(item.text, {
              inputId: item.id ?? `${INPUT_ID_PREFIX}${++this.inputSeq}`,
              images: item.images,
              suffix: this.inputSuffix(item.context),
              ...(item.context ? { context: true } : {}),
            }),
            id,
          );
        } else {
          this.messages.set(item.message.id, item.message);
          this.budget.restore(item.message);
          this.prepareRequest(item.message);
          this.detach(this.deliver(item.message), item.message.to);
        }
      }
    }
    const queued = AGENT_IDS.reduce((total, id) => total + state.queue[id].length, 0);
    this.options.bus.publish({ kind: "notice", text: t("notice.recovered", { interrupted: state.interrupted.length, queued }) });
    for (const id of AGENT_IDS) this.mailboxes[id].resume();
  }

  constructor(private readonly options: CoordinatorOptions) {
    this.workBaselines = new WorkBaselines(options.projectRoot, options);
    this.metricsStore = options.metricsStore ?? new TaskMetricsStore();
    this.metrics = new TaskMetricsRecorder(options.conversationId ?? "", this.metricsStore);
    options.bus.subscribe(event => {
      if (event.kind === "agent" && event.event.type === "turn_started")
        this.metrics.start(event.agent, this.mailboxes?.[event.agent]?.current?.taskId, event.at);
      this.metrics.record(event);
    });
    if (options.brainstormComplete) this.brainstormPhase = "done";
    const { agents, bus, mcpUrlFor, instructions, limits, settings } = options;
    for (const inputId of options.knownInputIds ?? []) this.rememberInputId(inputId);
    this.deliveryNotes = new DeliveryNotes(options.soloReleased, options.consumeSoloReleased);
    this.budget = new BudgetManager(limits);
    for (const message of options.knownMessages ?? []) {
      this.messages.set(message.id, message);
      if (!options.parallelParent && message.parallel && message.thread && !this.threadSenders.has(message.thread)) {
        this.threadSenders.set(message.thread, message.from);
      }
    }
    this.usage = new UsageMonitor(bus, { ...DEFAULT_USAGE_ALERT, ...options.usageAlert }, undefined, options.threadTokenWarn, options.usageNotifications);
    for (const id of AGENT_IDS) {
      agents[id].onEvent(event => {
        if (event.type === "turn_started") {
          const current = this.mailboxes?.[id]?.current;
          this.handoffTurns[id] = current ? RETRIED_TYPES.has(current.type) : false;
          const inputId = this.mailboxes?.[id]?.activeInputId;
          this.turnInputs[id] = inputId ? [inputId] : [];
        }
        if (event.type === "rate_limit") this.liveUsage.add(id);
        if (event.type === "subagents") this.subagents[id] = [...event.running];
        if (event.type === "background_tasks") this.backgroundTasks[id] = [...event.running];
        const files = this.workRecorder.record(id, event);
        this.workBaselines.record(id, event);
        for (const peer of peersOf(id)) this.deliveryNotes.recordPeerFiles(peer, files);
        if (["turn_started", "text", "tool", "turn"].includes(event.type)) this.notifyRecoveryChange();
        const handoff = event.type === "turn" && this.handoffTurns[id] === true;
        if (event.type === "turn") delete this.handoffTurns[id];
        const inputIds = event.type === "turn" && event.result.status === "interrupted" ? this.turnInputs[id] : undefined;
        if (event.type === "turn") delete this.turnInputs[id];
        bus.publish({ kind: "agent", agent: id, event, ...(handoff ? { handoff: true } : {}), ...(inputIds?.length ? { inputIds } : {}) });
        if (event.type === "turn") {
          if (event.result.status === "failed") {
            const mailbox = this.mailboxes?.[id];
            if (mailbox && !mailbox.activeSending && !mailbox.holding && !mailbox.isClosed) {
              const hold = this.limitHold(id);
              if (hold) {
                this.enterLimitHold(id, hold);
                mailbox.holdForLimit(hold);
              }
            }
          }
          if (id === this.options.parallelParent?.to) this.maybeStopParallelAgent();
        }
      });
      // 起動前なので値を保持するだけ（次の起動時に使われる）
      const { permission, model, effort } = settings?.[id] ?? {};
      if (permission) this.detach(agents[id].setPermission(permission), id);
      if (model) this.detach(agents[id].setModel(model), id);
      if (effort && AGENT_META[id].effortLevels.length) this.detach(agents[id].setEffort(effort), id);
    }
    const createMailbox = (id: AgentId) => {
      const resumeSessionId = options.resumeSessionIds?.[id];
      const mcpUrl = mcpUrlFor(id);
      return new AgentMailbox(
        agents[id],
        () => {
          const instruction = instructions?.(id);
          return {
            cwd: this.options.projectRoot,
            mcpUrl,
            ...(instruction ? { instructions: instruction } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
          };
        },
        message => bus.publish({ kind: "agent", agent: id, event: { type: "error", message } }),
        () => this.notifyRecoveryChange(),
        () => {
          if (this.options.canStart?.() === false) throw new Error(t("sandbox.incomplete"));
          this.options.onAgentStart?.();
        },
        () => {
          const hold = this.limitHold(id);
          if (hold) this.enterLimitHold(id, hold);
          return hold;
        },
        () => this.deliveryNotes.take(id),
        () => {
          this.options.clearSession?.(id);
          this.usage.clearContext(id);
        },
        message => this.metrics.deliver(message),
        result => {
          if (result.status !== "completed" || !result.deniedTools?.length) return undefined;
          const text = `[Clodex] These tools were denied by the current permission mode: ${result.deniedTools.join(", ")}. ${DENIED_CONTINUE}`;
          bus.publish({ kind: "notice", text });
          return `${text}${this.reminder}`;
        },
      );
    };
    this.mailboxes = agentRecord(createMailbox);
  }

  private rememberInputId(id: string): void {
    if (!id.startsWith(INPUT_ID_PREFIX)) return;
    const sequence = Number(id.slice(INPUT_ID_PREFIX.length));
    if (Number.isSafeInteger(sequence)) this.inputSeq = Math.max(this.inputSeq, sequence);
  }

  private limitHold(id: AgentId): { resumeAt: number; text: string; time: string } | undefined {
    const resetAt = limitResetAt(this.usage.snapshot(id));
    if (resetAt === undefined) return undefined;
    const resumeAt = resetAt * MS_PER_SECOND + (this.options.limitResumeMarginMs ?? DEFAULT_LIMIT_RESUME_MARGIN_MS);
    const time = new Date(resumeAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return { resumeAt, time, text: `${LIMIT_CONTINUE}${this.reminder}` };
  }

  private enterLimitHold(id: AgentId, hold: { resumeAt: number; time: string }): void {
    this.deliveryNotes.beginHold(id);
    this.notifyPeerLimit(id, hold.resumeAt);
    this.options.bus.publish({
      kind: "notice",
      text: t("notice.limitHold", { agent: id, time: hold.time }),
      level: "warn",
      limitHold: { agent: id, time: hold.time },
    });
  }

  private notifyPeerLimit(id: AgentId, resumeAt: number): void {
    if (this.options.solo?.()) return;
    for (const peer of peersOf(id)) this.notifyLimitTo(id, peer, resumeAt);
  }

  private notifyLimitTo(id: AgentId, peer: AgentId, resumeAt: number): void {
    if (this.options.agents[peer].status === "stopped") return;
    const work = this.workRecorder.lastWork(id);
    const plan = work?.plan ? ` Its last plan: ${work.plan}.` : "";
    const files = work?.files.size ? ` Files it edited in its last turn: ${[...work.files].join(", ")}. Do not edit these files until it resumes.` : "";
    const notice = `[Clodex] ${id} hit its usage limit and resumes at ${new Date(resumeAt).toISOString()}.${plan}${files}`;
    if (this.options.agents[peer].status !== "busy") {
      this.deliveryNotes.queueNotice(peer, notice);
      return;
    }
    this.detach(
      this.steerWithNotice(peer, notice, randomUUID())
        .then(sent => {
          if (!sent) this.deliveryNotes.queueNotice(peer, notice);
        })
        .catch((error: unknown) => {
          this.deliveryNotes.queueNotice(peer, notice);
          throw error;
        }),
      peer,
    );
  }

  setLimits(limits: BudgetLimits): void {
    this.budget.setLimits(limits);
  }

  askUser(agent: AgentId, input: unknown): AskUserResult {
    const { result, question } = this.questions.ask(agent, input);
    if (question) {
      this.options.bus.publish({ kind: "question", ...question });
      this.notifyRecoveryChange();
    }
    return result;
  }

  pendingQuestions(): PendingQuestion[] {
    return this.questions.pending();
  }

  taskMetrics(): ConversationTaskMetrics {
    return this.metricsStore.snapshot(this.options.conversationId ?? "");
  }

  recordPeerFiles(agent: AgentId, files: readonly string[]): void {
    this.workBaselines.recordPeerFiles(agent, files);
  }

  answer(id: string, input: unknown): string | undefined {
    const answer = this.questions.answer(id, input);
    if (!answer.ok) return answer.error;
    this.options.bus.publish({ kind: "answer", id, agent: answer.question.agent, answers: answer.answers });
    for (const line of answer.context) this.deliveryNotes.queueHumanContext(answer.question.agent, line);
    this.detach(
      this.mailboxes[answer.question.agent].enqueue(answer.text, { inputId: `${INPUT_ID_PREFIX}${++this.inputSeq}`, suffix: this.reminder }),
      answer.question.agent,
    );
    this.notifyRecoveryChange();
    return undefined;
  }

  // MCP の send_message から呼ばれる。検証・記録・配送を行い、受理結果を送信元へ返す
  receiveMessage(from: AgentId, input: unknown): CreateMessageResult {
    const { projectRoot, createMessageId } = this.options;
    if (this.options.brainstorm) return { ok: false, error: BRAINSTORM_REJECTED };
    if (this.options.solo?.()) return { ok: false, error: SOLO_REJECTED };
    const result = createMessage(input, {
      from,
      repository: projectRoot,
      ...(createMessageId ? { createId: createMessageId } : {}),
    });
    if (!result.ok) return result;
    if (this.options.parallelParent && (result.message.parallel || result.message.worktree))
      return { ok: false, error: "parallel: unavailable in a child conversation" };
    return this.acceptMessage(result);
  }

  async receiveMessageFromTool(from: AgentId, input: unknown): Promise<CreateMessageResult> {
    if (this.options.brainstorm) return { ok: false, error: BRAINSTORM_REJECTED };
    if (this.options.solo?.()) return { ok: false, error: SOLO_REJECTED };
    const result = createMessage(input, {
      from,
      repository: this.options.projectRoot,
      ...(this.options.createMessageId ? { createId: this.options.createMessageId } : {}),
    });
    if (!result.ok) return result;
    const { message } = result;
    if (this.options.parallelParent && (message.parallel || message.worktree)) return { ok: false, error: "parallel: unavailable in a child conversation" };
    if (
      this.options.forwardToParent &&
      from === this.options.parallelParent?.to &&
      message.to === this.options.parallelParent.from &&
      this.isParallelRequestChain(message)
    )
      return this.forwardChildMessage(result);
    const mailbox = this.mailboxes[message.to];
    if (message.parallel && (message.worktree || this.options.agents[message.to].status === "busy" || !mailbox.isIdle)) {
      if (!this.options.startParallel) return { ok: false, error: "parallel: unavailable" };
      const budgetError = this.budget.preview(message, this.mailboxes[from].current);
      if (budgetError) return { ok: false, error: budgetError };
      let prepared: { thread: string } | { error: string };
      try {
        prepared = await this.options.startParallel(message);
      } catch (error) {
        prepared = { error: error instanceof Error ? error.message : String(error) };
      }
      if ("error" in prepared)
        return { ok: false, error: `parallel: ${prepared.error.split(/\r?\n/, 1)[0]}. Remove worktree or wait for the recipient to finish` };
      message.thread = prepared.thread;
      const accepted = this.acceptMessage(result);
      if (!accepted.ok) await this.options.discardParallel?.(prepared.thread);
      return accepted;
    }
    return this.acceptMessage(result);
  }

  receiveChildMessage(message: AgentMessage, thread: string, parentMessageId: string): CreateMessageResult {
    const parent = this.messages.get(message.replyTo ?? "") ?? this.messages.get(parentMessageId);
    if (!parent) return { ok: false, error: "parallel: parent request is missing" };
    message.thread = thread;
    return this.acceptMessage({ ok: true, message }, parent, true);
  }

  async receiveForwardedMessage(message: AgentMessage): Promise<void> {
    this.messages.set(message.id, message);
    this.options.bus.publish({ kind: "message", message });
    this.prepareRequest(message);
    if (message.type === "CANCEL" && this.mailboxes[message.to].cancel(message.replyTo ?? "")) return;
    if (message.type === "CANCEL" && message.replyTo && this.requestState(message.replyTo, message.to) === "active") this.repliedRequests.add(message.replyTo);
    await this.deliver(message);
  }

  requestState(requestId: string, to: AgentId): RequestState {
    const mailbox = this.mailboxes[to];
    if (mailbox.current?.id === requestId) return "active";
    if (mailbox.pendingMessages.some(message => message.id === requestId)) return "queued";
    return "finished";
  }

  private forwardChildMessage(result: Extract<CreateMessageResult, { ok: true }>): CreateMessageResult {
    this.attachEvidence(result.message);
    const forwarded = this.options.forwardToParent?.(result.message);
    if (!forwarded?.ok) return forwarded ?? { ok: false, error: "parallel: parent conversation is unavailable" };
    this.messages.set(result.message.id, result.message);
    this.options.bus.publish({ kind: "message", message: result.message });
    const current = this.mailboxes[result.message.from].current;
    if (current && RETRIED_TYPES.has(current.type) && result.message.to === current.from) this.repliedRequests.add(current.id);
    if (result.message.type !== "ACK" && this.handoffTurns[result.message.from] !== undefined) this.handoffTurns[result.message.from] = true;
    if (result.message.type === "RESULT" && result.message.replyTo === this.options.parallelParent?.messageId) {
      this.parallelResultPending = true;
      this.maybeStopParallelAgent();
    }
    return result;
  }

  private isParallelRequestChain(message: AgentMessage): boolean {
    const rootId = this.options.parallelParent?.messageId;
    if (!rootId) return false;
    const rootThread = this.messages.get(rootId)?.thread;
    const visited = new Set<string>();
    let parent = message.replyTo ? this.messages.get(message.replyTo) : this.mailboxes[message.from].current;
    while (parent && !visited.has(parent.id)) {
      if (parent.id === rootId || (rootThread && parent.thread === rootThread)) return true;
      visited.add(parent.id);
      parent = parent.replyTo ? this.messages.get(parent.replyTo) : undefined;
    }
    return false;
  }

  private isParentDelivery(message: AgentMessage): boolean {
    const parent = this.options.parallelParent;
    if (!parent || message.from !== parent.from) return false;
    if (message.id === parent.messageId) return true;
    const thread = this.messages.get(parent.messageId)?.thread;
    return thread !== undefined && message.thread === thread;
  }

  private maybeStopParallelAgent(): void {
    const target = this.options.parallelParent?.to;
    if (!target || !this.parallelResultPending || this.parallelStopWaiting || this.options.agents[target].status === "busy") return;
    this.parallelStopWaiting = true;
    const mailbox = this.mailboxes[target];
    if (mailbox.holding) {
      this.parallelStopWaiting = false;
      return;
    }
    this.detach(
      mailbox.whenIdle().then(async () => {
        this.parallelStopWaiting = false;
        if (!this.parallelResultPending || !mailbox.isIdle || mailbox.holding || this.options.agents[target].status === "busy") return;
        mailbox.pause();
        try {
          this.parallelResultPending = false;
          await this.options.agents[target].stop();
        } finally {
          mailbox.resume();
        }
      }),
      target,
    );
  }

  private acceptMessage(result: Extract<CreateMessageResult, { ok: true }>, parentOverride?: AgentMessage, forwarded = false): CreateMessageResult {
    const { bus } = this.options;
    const { message } = result;
    const fresh =
      message.thread && message.parallel
        ? false
        : (message.fresh ??
          (!message.interrupt && (message.type === "DELEGATE" || message.type === "REVIEW_REQUEST") ? this.options.freshThread?.[message.type] : undefined));
    if (fresh) message.fresh = true;
    else delete message.fresh;
    const repliedTo = message.replyTo ? this.messages.get(message.replyTo) : undefined;
    if (repliedTo?.thread && !message.thread) message.thread = repliedTo.thread;
    if (message.type === "ANSWER" && (repliedTo?.type !== "QUESTION" || repliedTo.to !== message.from || repliedTo.from !== message.to))
      return { ok: false, error: "replyTo: ANSWER must reply to a QUESTION received from the recipient" };
    if (
      FOLLOWUP_TYPES.has(message.type) &&
      ((repliedTo?.type !== "DELEGATE" && repliedTo?.type !== "REVIEW_REQUEST") || repliedTo.from !== message.from || repliedTo.to !== message.to)
    )
      return { ok: false, error: `replyTo: ${message.type} must refer to a DELEGATE or REVIEW_REQUEST you sent to the recipient` };
    if (message.type === "RESULT" && repliedTo?.type === "QUESTION") return { ok: false, error: 'replyTo: reply to a QUESTION with type="ANSWER"' };
    const requestState =
      FOLLOWUP_TYPES.has(message.type) && message.replyTo
        ? message.thread && this.options.threadRequestState
          ? this.options.threadRequestState(message.thread, message.replyTo, message.to)
          : this.requestState(message.replyTo, message.to)
        : undefined;
    if (message.type === "CANCEL" && requestState === "finished") return { ok: false, error: "replyTo: the request is already finished" };
    if (FOLLOWUP_TYPES.has(message.type)) {
      if (requestState === "active") message.interrupt = true;
      else delete message.interrupt;
    }
    if (message.spec !== undefined) {
      const specPath = resolveSpecFile(message.repository, message.spec);
      if (!specPath)
        return {
          ok: false,
          error: `spec: must be a path relative to ${message.repository} of an existing regular file inside it (for a worktree under it, include the worktree directory)`,
        };
    }

    // 送信元が処理中の message を親として chain を決める（DESIGN.md §14）
    const parent = parentOverride ?? (FOLLOWUP_TYPES.has(message.type) ? repliedTo : this.mailboxes[message.from].current);
    const budgetError = this.budget.admit(message, parent);
    if (budgetError) {
      bus.publish({ kind: "agent", agent: message.from, event: { type: "error", message: humanBudgetError(budgetError) } });
      return { ok: false, error: budgetError };
    }

    if (parent && RETRIED_TYPES.has(parent.type) && message.to === parent.from) this.repliedRequests.add(parent.id);
    if (message.type === "CANCEL" && requestState === "active" && message.replyTo && !message.thread) this.repliedRequests.add(message.replyTo);
    if (!forwarded && message.type !== "ACK" && this.handoffTurns[message.from] !== undefined) this.handoffTurns[message.from] = true;
    this.messages.set(message.id, message);
    if (!this.options.parallelParent && message.parallel && message.thread && !this.threadSenders.has(message.thread))
      this.threadSenders.set(message.thread, message.from);
    this.attachEvidence(message);
    bus.publish({ kind: "message", message });
    this.prepareRequest(message);
    // ACK は記録のみ。配送して Agent を起こさない（DESIGN.md §12, §25）
    if (message.type === "CANCEL" && requestState === "queued" && !message.thread) this.mailboxes[message.to].cancel(message.replyTo ?? "");
    else if (message.type !== "ACK") this.detach(this.deliver(message), message.to);
    return result;
  }

  private prepareSpec(message: AgentMessage): () => void {
    delete message.specChanges;
    delete message.specHash;
    const path = message.spec ? resolveSpecFile(message.repository, message.spec) : undefined;
    if (!path) return () => {};
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return () => {};
    }
    const key = `${message.to}\0${path}`;
    const sessionId = this.options.agents[message.to].sessionId;
    const previous = this.specSnapshots.get(key);
    if (sessionId !== undefined && previous?.sessionId === sessionId) message.specChanges = changedSections(previous.content, content);
    message.specHash = createHash("sha256").update(content).digest("hex").slice(0, SPEC_HASH_LENGTH);
    return () => this.specSnapshots.set(key, { content, sessionId });
  }

  private prepareRequest(message: AgentMessage): void {
    if (message.thread && this.threadSenders.get(message.thread) === message.from) return;
    if (message.type !== "DELEGATE" && message.type !== "REVIEW_REQUEST") return;
    const path = message.spec ? resolveSpecFile(this.options.projectRoot, message.spec) : undefined;
    if (!path) return;
    try {
      this.requestSpecs.set(message.id, readFileSync(path, "utf8"));
    } catch {
      // 読み取り失敗は配送を妨げない。
    }
    if (!this.options.specCheck || !message.spec || message.specCheck || this.specChecks.has(message.id)) return;
    const root = this.workBaselines.rootFor(message);
    this.specChecks.set(
      message.id,
      runSpecCheck(this.options.specCheck, relative(root, path), root).then(result => {
        message.specCheck = result;
        this.options.bus.publish({ kind: "spec_check", messageId: message.id, result });
      }),
    );
  }

  private attachEvidence(message: AgentMessage): void {
    if (message.type !== "RESULT") return;
    let request = this.messages.get(message.replyTo ?? "");
    if (request?.type === "FIX" || request?.type === "ADD") request = this.messages.get(request.replyTo ?? "");
    if (!request || request.to !== message.from || request.from !== message.to) return;
    const evidence = this.workBaselines.finish(request.id);
    if (evidence) message.evidence = evidence;
  }

  private async prepareMessage(message: AgentMessage, attempt: number, interrupt = false): Promise<PreparedSend> {
    await this.specChecks.get(message.id);
    this.workBaselines.start(message, this.requestSpecs.get(message.id));
    if ((message.type === "FIX" || message.type === "ADD") && message.replyTo) this.workBaselines.resume(message.replyTo);
    const delivery = { ...message, ...(interrupt ? { interrupt: true } : {}) };
    const onSent = this.prepareSpec(delivery);
    const effort = !interrupt && AGENT_META[message.to].effortInMessage ? message.effort : undefined;
    const knownEffort = this.options.agents[message.to].effort !== undefined;
    if (effort && !knownEffort) this.options.bus.publish({ kind: "notice", text: t("notice.unknownEffort"), level: "warn" });
    return {
      text: `${attempt > 1 ? `${RETRY_NOTE}\n` : ""}${buildEnvelope(delivery, this.language)}`,
      ...(effort && knownEffort ? { options: { effort } } : {}),
      onSent: () => {
        onSent();
        this.workBaselines.markSent(message.id);
      },
    };
  }

  // interrupt: 宛先が送信元からの message を処理中なら、そのターンに足す。足せなければキューに積む（DESIGN.md §28 v0.3 C）
  private async deliver(message: AgentMessage, attempt = 1): Promise<void> {
    if (message.thread && this.threadSenders.get(message.thread) === message.from && this.options.deliverToThread) {
      await this.options.deliverToThread(message.thread, message);
      return;
    }
    const mailbox = this.mailboxes[message.to];
    const followsCurrentRequest = FOLLOWUP_TYPES.has(message.type) && mailbox.current?.id === message.replyTo;
    if (attempt > 1) this.options.bus.publish({ kind: "retry", to: message.to, messageId: message.id, attempt });
    const steerable =
      (message.type === "ANSWER" && this.options.agents[message.to].status === "busy") ||
      followsCurrentRequest ||
      (!FOLLOWUP_TYPES.has(message.type) && message.interrupt && mailbox.current?.from === message.from);
    if (message.type === "CANCEL" && !followsCurrentRequest) return;
    if (!message.fresh && steerable) {
      const prepared = await this.prepareMessage(message, attempt, true);
      if (await this.steerWithNotice(message.to, prepared.text, message.id)) {
        prepared.onSent();
        this.metrics.steer(message.to, message.taskId);
        this.metrics.deliver(message);
        return;
      }
    }
    const result = await mailbox.enqueue("", {
      message,
      prepare: interrupt => this.prepareMessage(message, attempt, interrupt),
      ...(message.fresh && attempt === 1 ? { fresh: true } : {}),
    });
    const replied = this.repliedRequests.delete(message.id);
    if (RETRIED_TYPES.has(message.type) && result.status === "completed" && result.text.trim() && !replied && !mailbox.isClosed && !mailbox.holding)
      this.autoReply(message, result.text);
    // 上限で待っている宛先は、リセット後に続きを送るので送り直さない
    if (result.status !== "failed" || !RETRIED_TYPES.has(message.type) || mailbox.isClosed || mailbox.holding) return;
    if (attempt < MAX_DELIVERY_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS).unref?.());
      if (!mailbox.isClosed) await this.deliver(message, attempt + 1);
      return;
    }
    const error = (result.text.split("\n", 1)[0] ?? "").slice(0, ERROR_LINE_LENGTH);
    if (this.options.forwardFailureToParent && this.isParentDelivery(message)) {
      this.options.forwardFailureToParent(message, error);
      return;
    }
    this.reportDeliveryFailure(message, error);
  }

  reportDeliveryFailure(message: AgentMessage, error: string): void {
    const sender = this.mailboxes[message.from];
    if (sender.isClosed) return;
    this.options.bus.publish({ kind: "notice", text: t("notice.handoffFailed", { type: message.type, to: message.to, from: message.from }), level: "warn" });
    this.detach(sender.enqueue(handoffFallback(message, error), { inputId: `${INPUT_ID_PREFIX}${++this.inputSeq}`, suffix: this.reminder }), message.from);
  }

  private autoReply(request: AgentMessage, text: string): void {
    const body = text.length > MAX_BODY_LENGTH ? `${text.slice(0, MAX_BODY_LENGTH - 1)}…` : text;
    const answer = request.type === "QUESTION";
    const created = createMessage(
      {
        to: request.from,
        type: answer ? "ANSWER" : "RESULT",
        taskId: request.taskId,
        replyTo: request.type === "FIX" || request.type === "ADD" ? request.replyTo : request.id,
        body,
      },
      { from: request.to, repository: this.options.projectRoot, ...(this.options.createMessageId ? { createId: this.options.createMessageId } : {}) },
    );
    if (!created.ok) return;
    const message: AgentMessage = { ...created.message, auto: true };
    this.attachEvidence(message);
    if (
      this.options.forwardToParent &&
      message.from === this.options.parallelParent?.to &&
      message.to === this.options.parallelParent.from &&
      this.isParallelRequestChain(message)
    ) {
      this.forwardChildMessage({ ok: true, message });
      return;
    }
    if (request.thread) message.thread = request.thread;
    const budgetError = this.budget.admit(message, request);
    if (budgetError) {
      this.options.bus.publish({ kind: "agent", agent: request.to, event: { type: "error", message: humanBudgetError(budgetError) } });
      return;
    }
    this.messages.set(message.id, message);
    this.options.bus.publish({ kind: "message", message });
    this.detach(this.deliver(message), message.to);
  }

  // @agent!: 実行中なら steer し、そうでなければ通常の送信（DESIGN.md §28 v0.3 C）
  async steerOrSend(id: AgentId, text: string, context = false, shared = false): Promise<"steered" | "queued"> {
    const steerId = randomUUID();
    if (await this.steerWithNotice(id, `${text}${this.inputSuffix(context)}`, steerId)) {
      this.metrics.steer(id);
      this.turnInputs[id]?.push(steerId);
      this.options.bus.publish({ kind: "human", agent: id, text, steer: true, steerId });
      if (!shared) this.deliveryNotes.queueHumanContext(id, text);
      return "steered";
    }
    this.detach(this.sendToAgent(id, text, [], context, shared), id);
    return "queued";
  }

  private async steerWithNotice(id: AgentId, text: string, steerId: string): Promise<boolean> {
    const note = this.deliveryNotes.peek(id);
    if (!(await this.options.agents[id].steer(`${text}${note}`, steerId))) return false;
    this.deliveryNotes.consume(id);
    return true;
  }

  sendToAgent(id: AgentId, text: string, images: readonly string[] = [], context = false, shared = false): Promise<TurnResult> {
    const inputId = `${INPUT_ID_PREFIX}${++this.inputSeq}`;
    this.options.bus.publish({ kind: "human", agent: id, text, inputId });
    if (!shared) this.deliveryNotes.queueHumanContext(id, text);
    return this.mailboxes[id].enqueue(text, {
      inputId,
      images,
      suffix: this.inputSuffix(context),
      ...(context ? { context: true } : {}),
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
    return AGENT_IDS.every(id => this.options.agents[id].status !== "busy" && this.mailboxes[id].isIdle);
  }

  get workDir(): string {
    return this.options.projectRoot;
  }

  async relocate(workDir: string): Promise<string | undefined> {
    const busy = AGENT_IDS.filter(id => ["busy", "starting"].includes(this.options.agents[id].status) || !this.mailboxes[id].isIdle);
    if (busy.length) return t("reject.busy", { agents: busy.join(", ") });
    const started = AGENT_IDS.filter(id => this.options.agents[id].status !== "stopped");
    const sessions = Object.fromEntries(started.map(id => [id, this.mailboxes[id].sessionId])) as Partial<Record<AgentId, string>>;
    const previousDir = this.options.projectRoot;
    for (const id of AGENT_IDS) this.mailboxes[id].pause();
    try {
      await Promise.all(started.map(id => this.options.agents[id].stop()));
      this.options.projectRoot = workDir;
      for (const id of started) this.mailboxes[id].switchSession(sessions[id]);
      await Promise.all(started.map(id => this.mailboxes[id].ensureRunning()));
      return undefined;
    } catch (error) {
      this.options.projectRoot = previousDir;
      await Promise.all(started.map(id => this.options.agents[id].stop().catch(() => undefined)));
      for (const id of started) this.mailboxes[id].switchSession(sessions[id]);
      await Promise.all(started.map(id => this.mailboxes[id].ensureRunning().catch(() => undefined)));
      return error instanceof Error ? error.message : String(error);
    } finally {
      for (const id of AGENT_IDS) this.mailboxes[id].resume();
    }
  }

  // 送った順（ID の連番順）に並べる
  pendingInputs(): PendingInput[] {
    const seq = (id: string) => Number(id.slice(INPUT_ID_PREFIX.length));
    return AGENT_IDS.flatMap(agent => this.mailboxes[agent].pendingInputs.map(input => ({ ...input, agent }))).sort((a, b) => seq(a.id) - seq(b.id));
  }

  pendingMessages(): PendingMessage[] {
    return AGENT_IDS.flatMap(agent =>
      this.mailboxes[agent].pendingMessages.map(message => ({
        id: message.id,
        agent,
        from: message.from,
        type: message.type,
        taskId: message.taskId,
        text: message.body,
        ...(message.fresh ? { fresh: true as const } : {}),
      })),
    );
  }

  async steerQueued(id: string): Promise<SteerQueuedResult> {
    const input = this.pendingInputs().find(item => item.id === id);
    const message = this.pendingMessages().find(item => item.id === id);
    const target = input ?? message;
    if (!target) return { ok: false, reason: "missing" };
    const mailbox = this.mailboxes[target.agent];
    if (!AGENT_META[target.agent].steer) return { ok: false, reason: "unsupported", agent: target.agent };
    if (message?.fresh) return { ok: false, reason: "fresh", agent: target.agent };
    if (mailbox.holding) return { ok: false, reason: "holding", agent: target.agent };
    if (this.options.agents[target.agent].status !== "busy") return { ok: false, reason: "idle", agent: target.agent };
    const steerId = input ? randomUUID() : id;
    try {
      const sent = await mailbox.steerQueued(id, async queued => {
        const images = queued.images?.length ? `\n\n${STEER_IMAGE_INSTRUCTION}\n${queued.images.join("\n")}` : "";
        const prepared = await queued.prepare?.(true);
        const text = prepared?.text ?? `${queued.text}${queued.suffix ?? ""}${images}`;
        const sent = await this.steerWithNotice(target.agent, text, steerId);
        if (sent) {
          prepared?.onSent();
          this.metrics.steer(target.agent, queued.message?.taskId);
          if (queued.message) this.metrics.deliver(queued.message);
        }
        return sent;
      });
      if (!sent) return { ok: false, reason: "rejected", agent: target.agent };
      if (input) {
        this.turnInputs[target.agent]?.push(id);
        this.options.bus.publish({ kind: "steered", inputId: id, steerId });
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "rejected", agent: target.agent };
    }
  }

  // ID 省略時は最後に送った配送待ちの入力。取り消せなければ undefined
  cancelInput(id?: string): PendingInput | PendingMessage | undefined {
    const target = id
      ? (this.pendingInputs().find(input => input.id === id) ?? this.pendingMessages().find(message => message.id === id))
      : this.pendingInputs().at(-1);
    if (!target || this.mailboxes[target.agent].cancel(target.id) === undefined) return undefined;
    this.options.bus.publish({ kind: "canceled", id: target.id, agent: target.agent, text: target.text });
    return target;
  }

  // 全 Agent の配送が終わるまで待つ。配送中のターンが相手へ message を送ることがあるので、全員が同時に空になるまで繰り返す
  async whenIdle(): Promise<void> {
    while (!AGENT_IDS.every(id => this.mailboxes[id].isIdle)) {
      await Promise.all(AGENT_IDS.map(id => this.mailboxes[id].whenIdle()));
    }
  }

  // /resume・/new: targets の Agent を止め、次回はそれぞれ指定の session（無ければ新規）で起動する。拒否したら理由を返す
  async switchSessions(sessions: Partial<Record<AgentId, string>>, targets: readonly AgentId[] = AGENT_IDS): Promise<string | undefined> {
    // 起動中や配送待ちも含めて、受け付けた作業がある Agent は止めない
    const busy = targets.filter(id => this.options.agents[id].status === "busy" || !this.mailboxes[id].isIdle);
    if (busy.length) return t("reject.busy", { agents: busy.join(", ") });
    for (const id of targets) this.mailboxes[id].pause();
    try {
      await Promise.all(targets.map(id => this.options.agents[id].stop()));
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
    const targets = id ? [id] : AGENT_IDS.filter(agent => this.options.agents[agent].status !== "stopped");
    return Promise.all(targets.map(target => this.mailboxes[target].enqueueCompact()));
  }

  private handoffRejection(id: AgentId): string | undefined {
    const { status } = this.options.agents[id];
    const mailbox = this.mailboxes[id];
    if (status === "busy" || status === "starting" || this.sessionHandoffs.has(id)) return t("notice.sessionHandoffBusy", { agent: id });
    if ([mailbox.current, ...mailbox.pendingMessages].some(message => message && HANDOFF_REQUEST_TYPES.has(message.type)))
      return t("notice.sessionHandoffRequests", { agent: id });
    if (!mailbox.isIdle || mailbox.holding) return t("notice.sessionHandoffPending", { agent: id });
    if (this.subagents[id].length) return t("notice.sessionHandoffSubagents", { agent: id });
    if (this.backgroundTasks[id].length) return t("notice.sessionHandoffBackground", { agent: id });
    return undefined;
  }

  async handoff(id: AgentId): Promise<void> {
    const warn = (text: string) => this.options.bus.publish({ kind: "notice", level: "warn", text });
    const rejected = this.handoffRejection(id);
    if (rejected) return warn(rejected);
    this.sessionHandoffs.add(id);
    try {
      let path: string | undefined;
      if (this.options.agents[id].status !== "stopped" && this.mailboxes[id].sessionId) {
        if (!this.options.artifactsDir) return warn(t("notice.sessionHandoffFailed", { agent: id }));
        path = createHandoffPath(this.options.artifactsDir, id);
        const result = await this.sendToAgent(id, handoffInstruction(path), [], false, true);
        if (result.status !== "completed" || !hasHandoffDocument(path)) return warn(t("notice.sessionHandoffFailed", { agent: id }));
      }
      if (this.mailboxes[id].isClosed || this.subagents[id].length || this.backgroundTasks[id].length)
        return warn(t("notice.sessionHandoffFailed", { agent: id }));
      const error = await this.switchSessions({}, [id]);
      if (error) return warn(t("notice.sessionHandoffFailed", { agent: id }));
      this.options.clearSession?.(id);
      if (path) this.deliveryNotes.queueNotice(id, handoffNotice(path));
      this.options.bus.publish({
        kind: "notice",
        text: path ? t("notice.sessionHandoffDone", { agent: id, path }) : t("shell.agentFresh", { agent: id }),
      });
    } catch {
      warn(t("notice.sessionHandoffFailed", { agent: id }));
    } finally {
      this.sessionHandoffs.delete(id);
    }
  }

  // Agent 指定なしは、Agent 間のやり取りも止める: 配送待ちの formal message を破棄し、chain を閉じる
  async interrupt(id?: AgentId): Promise<void> {
    if (this.brainstormPhase === "round" || this.brainstormPhase === "summary") {
      this.brainstormInterrupted = true;
      this.brainstormAbort.abort();
    }
    if (!id) this.stopExchanges();
    const targets = id ? [id] : AGENT_IDS;
    for (const target of targets) {
      this.mailboxes[target].releaseHold();
      this.deliveryNotes.clearHold(target);
    }
    await Promise.all(targets.map(target => this.options.agents[target].interrupt()));
  }

  private stopExchanges(): void {
    const discarded = AGENT_IDS.flatMap(agent => this.mailboxes[agent].discardMessages());
    const processing = AGENT_IDS.flatMap(agent => this.mailboxes[agent].current ?? []);
    this.budget.closeChains([...discarded, ...processing]);
    if (discarded.length) {
      this.options.bus.publish({ kind: "notice", text: t("notice.discarded", { count: discarded.length }) });
    }
  }

  async setPermission(level: PermissionLevel, id?: AgentId): Promise<void> {
    if (this.options.brainstorm) return;
    if (this.options.permissionLocked?.()) throw new Error(t("sandbox.permission"));
    const targets = id ? [id] : AGENT_IDS;
    await Promise.all(targets.map(target => this.options.agents[target].setPermission(level)));
  }

  async setModel(model: string, id: AgentId): Promise<TurnResult | void> {
    return this.mailboxes[id].enqueueModel(model);
  }

  async setEffort(level: string, id?: AgentId): Promise<TurnResult | void> {
    if (id) return AGENT_META[id].effortLevels.length ? this.mailboxes[id].enqueueEffort(level) : undefined;
    const results = await Promise.all(
      AGENT_IDS.filter(agent => AGENT_META[agent].effortLevels.length).map(agent => this.mailboxes[agent].enqueueEffort(level)),
    );
    return results.find(result => result.status === "failed") ?? results[0];
  }

  status(): Array<{
    id: AgentId;
    status: AgentStatus;
    sessionId: string | undefined;
    permission: PermissionLevel;
    model: string | undefined;
    modelLabel: string;
    effort: string | undefined;
    models: ModelCatalog[AgentId];
    usage: UsageSnapshot;
    subagents: SubagentState[];
    backgroundTasks: SubagentState[];
    holdUntil?: string;
  }> {
    return AGENT_IDS.map(id => {
      const { status, permission, model, effort } = this.options.agents[id];
      const models = this.options.modelCatalog?.()[id] ?? [];
      const holdUntil = this.mailboxes[id].holdUntil;
      return {
        id,
        status,
        sessionId: this.mailboxes[id].sessionId,
        permission,
        model,
        modelLabel: modelLabel(model, models),
        effort,
        models,
        usage: this.usage.snapshot(id),
        subagents: [...this.subagents[id]],
        backgroundTasks: [...this.backgroundTasks[id]],
        ...(holdUntil ? { holdUntil } : {}),
      };
    });
  }

  applyStartupUsage(usage: StartupProbe["usage"]): void {
    for (const id of AGENT_IDS) {
      const event = usage[id];
      if (event && !this.liveUsage.has(id)) this.options.bus.publish({ kind: "agent", agent: id, event });
    }
  }

  async start(): Promise<void> {
    await Promise.all(AGENT_IDS.map(id => this.mailboxes[id].ensureRunning()));
  }

  async stop(): Promise<void> {
    this.stoppingRecovery = this.recoveryState();
    for (const id of AGENT_IDS) this.mailboxes[id].close();
    await Promise.all(AGENT_IDS.map(id => this.options.agents[id].stop()));
  }
}
