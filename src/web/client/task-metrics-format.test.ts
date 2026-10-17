import { describe, expect, it } from "vitest";
import { emptyTaskMetrics, type TaskMetrics } from "../../coordinator/task-metrics-summary.js";
import { format } from "../../i18n/i18n.js";
import { en, ja } from "../../i18n/messages.js";
import { formatTaskMetrics, recentTaskMetrics } from "./task-metrics-format.js";

describe("task 累計の表示", () => {
  it("既存の token 表記と日英の短い文言を使う", () => {
    const task = { ...emptyTaskMetrics("c", "T", ""), turns: 4, inputTokens: 1_200_000, durationMs: 38 * 60_000, questions: 1 };
    expect(formatTaskMetrics(task, (key, params) => format(ja[key], params))).toBe("4 ターン · 入力 1.2M · 38 分 · 質問 1");
    expect(formatTaskMetrics(task, (key, params) => format(en[key], params))).toBe("4 turns · in 1.2M · 38 min · 1 question");
    expect(formatTaskMetrics({ ...task, questions: 2 }, (key, params) => format(en[key], params))).toContain("2 questions");
  });
  it("最後の message の新しい順で5件を選び、ターンだけの task を除く", () => {
    const tasks: TaskMetrics[] = Array.from({ length: 7 }, (_, index) => ({ ...emptyTaskMetrics("c", String(index), ""), lastMessageAt: String(index) }));
    tasks.push(emptyTaskMetrics("c", "turn-only", "later"));
    expect(recentTaskMetrics(tasks).map(task => task.taskId)).toEqual(["6", "5", "4", "3", "2"]);
  });
});
