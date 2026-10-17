import type { TaskMetrics } from "../../coordinator/task-metrics-summary.js";
import type { t } from "../../i18n/i18n.js";
import { formatTokens } from "./token-format.js";

const MS_PER_MINUTE = 60_000;
const RECENT_TASK_COUNT = 5;

export const formatTaskMetrics = (task: TaskMetrics, translate: typeof t): string =>
  translate("metrics.summary", {
    turns: task.turns,
    input: formatTokens(task.inputTokens),
    minutes: Math.round(task.durationMs / MS_PER_MINUTE),
    questions: translate(task.questions === 1 ? "metrics.question" : "metrics.questions", { count: task.questions }),
  });

export const recentTaskMetrics = (tasks: readonly TaskMetrics[]): TaskMetrics[] =>
  tasks
    .filter(task => task.lastMessageAt !== undefined)
    .sort((a, b) => b.lastMessageAt!.localeCompare(a.lastMessageAt!))
    .slice(0, RECENT_TASK_COUNT);
