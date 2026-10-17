import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import { type AgentMessage, MESSAGE_TYPES, RESULT_STATUSES } from "../protocol/messages.js";
import type { CoordinatorEvent } from "./event-bus.js";
import { accumulateTaskMetric, emptyTaskMetrics, type TaskMetricRecord, type TaskMetrics, type TokenCounts } from "./task-metrics-summary.js";

const DELIVERY_TYPES: ReadonlySet<AgentMessage["type"]> = new Set(["DELEGATE", "REVIEW_REQUEST", "QUESTION", "ANSWER", "RESULT"]);
const number = z.number().finite().nonnegative();
const base = { conversationId: z.string(), at: z.iso.datetime({ offset: true }) };
const recordSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("turn"),
    agent: z.enum(AGENT_IDS),
    taskId: z.string().optional(),
    startedAt: z.iso.datetime({ offset: true }),
    status: z.enum(["completed", "interrupted", "failed"]),
    inputTokens: number,
    cachedInputTokens: number,
    outputTokens: number,
  }),
  z.object({
    ...base,
    kind: z.literal("message"),
    id: z.string(),
    type: z.enum(MESSAGE_TYPES),
    taskId: z.string(),
    from: z.enum(AGENT_IDS),
    to: z.enum(AGENT_IDS),
    replyTo: z.string().optional(),
    status: z.enum(RESULT_STATUSES).optional(),
    rework: z.enum(["spec", "impl", "check"]).optional(),
    relatesTo: z.string().optional(),
    auto: z.literal(true).optional(),
    fresh: z.boolean().optional(),
  }),
  z.object({ ...base, kind: z.literal("delivery"), messageId: z.string(), taskId: z.string(), waitMs: number }),
]);

export interface ConversationTaskMetrics {
  tasks: TaskMetrics[];
  unassigned?: TaskMetrics;
  results: Record<string, TaskMetrics>;
}

export const taskMetricsPath = (homeDir: string, statePath: string): string => join(homeDir, ".clodex", "metrics", `${basename(statePath, ".json")}.jsonl`);

export class TaskMetricsStore {
  private readonly summaries = new Map<string, ConversationTaskMetrics>();
  private readonly pendingResults = new Map<string, Array<Extract<TaskMetricRecord, { kind: "message" }>>>();

  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const records = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .flatMap(line => {
          try {
            const parsed = recordSchema.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
          } catch {
            return [];
          }
        });
      for (const record of records.sort((a, b) => a.at.localeCompare(b.at))) this.remember(record);
    } catch {
      // 計測ファイルを読めなくても Agent の起動を妨げない。
    }
  }

  append(record: TaskMetricRecord): void {
    this.remember(record);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    } catch {
      // 計測の失敗で作業を止めない。メモリ上の集計は保持する。
    }
  }

  private remember(record: TaskMetricRecord): void {
    const summary = this.summaries.get(record.conversationId) ?? ({ tasks: [], results: {} } as ConversationTaskMetrics);
    const task =
      (record.taskId === undefined ? summary.unassigned : summary.tasks.find(task => task.taskId === record.taskId)) ??
      emptyTaskMetrics(record.conversationId, record.taskId ?? "", record.at);
    accumulateTaskMetric(task, record);
    if (record.taskId === undefined) summary.unassigned = task;
    else if (!summary.tasks.includes(task)) summary.tasks.push(task);
    const pending = this.pendingResults.get(record.conversationId) ?? [];
    if (record.kind === "message" && record.type === "RESULT") {
      summary.results[record.id] = structuredClone(task);
      pending.push(record);
    }
    if (record.kind === "turn") {
      for (const result of pending) {
        if (result.from !== record.agent || result.at < record.startedAt) continue;
        const completed = summary.tasks.find(task => task.taskId === result.taskId);
        if (completed) summary.results[result.id] = structuredClone(completed);
      }
      this.pendingResults.set(
        record.conversationId,
        pending.filter(result => result.from !== record.agent),
      );
    } else this.pendingResults.set(record.conversationId, pending);
    this.summaries.set(record.conversationId, summary);
  }

  snapshot(conversationId: string): ConversationTaskMetrics {
    return structuredClone(this.summaries.get(conversationId) ?? { tasks: [], results: {} });
  }
}

const zero = (): TokenCounts => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
interface ActiveTurn {
  taskId?: string;
  startedAt: string;
  tokens: TokenCounts;
}

export class TaskMetricsRecorder {
  private readonly active = new Map<AgentId, ActiveTurn>();

  constructor(
    private readonly conversationId: string,
    private readonly store: TaskMetricsStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(agent: AgentId, taskId?: string, startedAt = this.now().toISOString()): void {
    this.active.set(agent, { taskId, startedAt, tokens: zero() });
  }

  steer(agent: AgentId, taskId?: string): void {
    const turn = this.active.get(agent);
    if (turn && turn.taskId !== taskId) turn.taskId = undefined;
  }

  deliver(message: AgentMessage): void {
    if (!DELIVERY_TYPES.has(message.type)) return;
    const at = this.now().toISOString();
    this.store.append({
      kind: "delivery",
      conversationId: this.conversationId,
      at,
      taskId: message.taskId,
      messageId: message.id,
      waitMs: Math.max(0, Date.parse(at) - Date.parse(message.createdAt)),
    });
  }

  record(event: CoordinatorEvent): void {
    const conversationId = this.conversationId;
    if (event.kind === "message") {
      const { id, type, taskId, from, to, replyTo, status, rework, relatesTo, auto, fresh } = event.message;
      this.store.append({ kind: "message", conversationId, at: event.at, id, type, taskId, from, to, replyTo, status, rework, relatesTo, auto, fresh });
      return;
    }
    if (event.kind !== "agent") return;
    const { agent, event: item } = event;
    const turn = this.active.get(agent);
    if (!turn) return;
    if (item.type === "usage") {
      turn.tokens.inputTokens += item.input;
      turn.tokens.cachedInputTokens += item.cachedInput;
      turn.tokens.outputTokens += item.output;
      return;
    }
    if (item.type !== "turn") return;
    this.active.delete(agent);
    this.store.append({
      kind: "turn",
      conversationId,
      agent,
      taskId: turn.taskId,
      startedAt: turn.startedAt,
      at: event.at,
      status: item.result.status,
      ...turn.tokens,
    });
  }
}
