import type { AgentId, TurnResult } from "../agents/agent-adapter.js";
import type { AgentMessage } from "../protocol/messages.js";

export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export type TaskMetricRecord =
  | ({ kind: "turn"; conversationId: string; agent: AgentId; taskId?: string; startedAt: string; at: string; status: TurnResult["status"] } & TokenCounts)
  | ({ kind: "message"; conversationId: string; at: string } & Pick<
      AgentMessage,
      "id" | "type" | "taskId" | "from" | "to" | "replyTo" | "status" | "rework" | "relatesTo" | "auto" | "fresh"
    >)
  | { kind: "delivery"; conversationId: string; at: string; messageId: string; taskId: string; waitMs: number };

export interface TaskMetrics extends TokenCounts {
  conversationId: string;
  taskId: string;
  turns: number;
  durationMs: number;
  waitMs: number;
  elapsedMs: number;
  questions: number;
  results: number;
  delegates: number;
  retries: number;
  rework: Record<"spec" | "impl" | "check", number>;
  accepted: boolean;
  firstAccepted: boolean;
  firstAt: string;
  lastAt: string;
  lastMessageAt?: string;
}

export const emptyTaskMetrics = (conversationId: string, taskId: string, at: string): TaskMetrics => ({
  conversationId,
  taskId,
  turns: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  durationMs: 0,
  waitMs: 0,
  elapsedMs: 0,
  questions: 0,
  results: 0,
  delegates: 0,
  retries: 0,
  rework: { spec: 0, impl: 0, check: 0 },
  accepted: false,
  firstAccepted: false,
  firstAt: at,
  lastAt: at,
});

export const aggregateTaskMetrics = (records: readonly TaskMetricRecord[]): { tasks: TaskMetrics[]; unassigned: TaskMetrics[] } => {
  const tasks = new Map<string, TaskMetrics>();
  const unassigned = new Map<string, TaskMetrics>();
  for (const record of [...records].sort((a, b) => a.at.localeCompare(b.at))) {
    const map = record.taskId === undefined ? unassigned : tasks;
    const key = JSON.stringify([record.conversationId, record.taskId]);
    const metric = map.get(key) ?? emptyTaskMetrics(record.conversationId, record.taskId ?? "", record.at);
    map.set(key, metric);
    accumulateTaskMetric(metric, record);
  }
  return { tasks: [...tasks.values()], unassigned: [...unassigned.values()] };
};

export const accumulateTaskMetric = (metric: TaskMetrics, record: TaskMetricRecord): void => {
  const firstAt = record.kind === "turn" ? record.startedAt : record.at;
  if (firstAt < metric.firstAt) metric.firstAt = firstAt;
  if (record.at > metric.lastAt) metric.lastAt = record.at;
  metric.elapsedMs = Math.max(0, Date.parse(metric.lastAt) - Date.parse(metric.firstAt));
  if (record.kind === "turn") {
    metric.turns++;
    metric.inputTokens += record.inputTokens;
    metric.cachedInputTokens += record.cachedInputTokens;
    metric.outputTokens += record.outputTokens;
    metric.durationMs += Math.max(0, Date.parse(record.at) - Date.parse(record.startedAt));
  } else if (record.kind === "delivery") {
    metric.waitMs += record.waitMs;
  } else {
    metric.lastMessageAt = record.at;
    if (record.type === "QUESTION") metric.questions++;
    if (record.type === "RESULT") {
      metric.results++;
      metric.accepted = record.status === "done" || record.status === "approved";
    }
    if (record.type === "DELEGATE") {
      if (metric.delegates++) metric.retries++;
      metric.accepted = false;
    }
    if (record.type === "FIX" || record.type === "ADD") {
      metric.retries++;
      metric.accepted = false;
    }
    if (record.rework) metric.rework[record.rework]++;
  }
  metric.firstAccepted = metric.accepted && metric.results === 1;
};
