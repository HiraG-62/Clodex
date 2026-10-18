import { describe, expect, it } from "vitest";
import { analyzeBaseline } from "./task-metrics-baseline.ts";

describe("基準値の推定", () => {
  it("親子のログの message ID を重複計上せず、子のターンの割当は保つ", () => {
    const events = [
      { kind: "message", at: "2026-01-01T00:00:00Z", message: { id: "d", type: "DELEGATE", taskId: "T", from: "claude", to: "codex" } },
      { kind: "message", at: "2026-01-01T00:00:01Z", message: { id: "q", type: "QUESTION", taskId: "T", from: "codex", to: "claude", replyTo: "d" } },
    ];
    const result = analyzeBaseline([
      { project: "test", conversationId: "parent", events },
      {
        project: "test",
        conversationId: "child",
        events: [
          ...events,
          { kind: "agent", agent: "codex", at: "2026-01-01T00:00:02Z", event: { type: "turn_started" } },
          { kind: "agent", agent: "codex", at: "2026-01-01T00:00:03Z", event: { type: "turn", result: { status: "completed" } } },
        ],
      },
    ]);
    expect(result.messages).toBe(2);
    expect(result.projects[0]).toMatchObject({ delegates: 1, questionsPerDelegate: 1, twoQuestionRate: 0 });
    expect(result.tasks.reduce((sum, task) => sum + task.delegates, 0)).toBe(1);
    expect(result.tasks.find(task => task.conversationId === "test/child")).toMatchObject({ turns: 1 });
  });
  it("RESULT 受信ターンの token 欠測は中央値から除く", () => {
    const result = analyzeBaseline([
      {
        project: "test",
        conversationId: "c",
        events: [
          { kind: "message", at: "2026-01-01T00:00:00Z", message: { id: "r", type: "RESULT", taskId: "T", from: "codex", to: "claude" } },
          { kind: "agent", agent: "claude", at: "2026-01-01T00:00:01Z", event: { type: "turn_started" } },
          { kind: "agent", agent: "claude", at: "2026-01-01T00:00:02Z", event: { type: "turn", result: { status: "completed" } } },
        ],
      },
    ]);
    expect(result.projects[0]?.resultInputMedian).toBeNull();
    expect(result.missingTokenTurns).toBe(1);
  });
  it("mailbox と人の入力からターンを割り当て、質問率と中央値を出す", () => {
    const events = [
      { kind: "message", message: { id: "d", type: "DELEGATE", taskId: "T", from: "claude", to: "codex", fresh: true } },
      { kind: "agent", agent: "codex", event: { type: "turn_started" } },
      { kind: "message", message: { id: "q", type: "QUESTION", taskId: "T", from: "codex", to: "claude", replyTo: "d" } },
      { kind: "agent", agent: "codex", event: { type: "context", inputTotal: 50, tokens: 50 } },
      { kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed" } } },
      { kind: "human", agent: "claude" },
      { kind: "agent", agent: "claude", event: { type: "turn_started" } },
      { kind: "agent", agent: "claude", event: { type: "context", inputTotal: 200, tokens: 200 } },
      { kind: "agent", agent: "claude", event: { type: "turn", result: { status: "completed" } } },
    ].map((event, index) => ({ ...event, at: new Date(index * 1000).toISOString() }));
    const result = analyzeBaseline([{ project: "test", conversationId: "c", events }]);
    expect(result.messages).toBe(2);
    expect(result.turns).toBe(2);
    expect(result.projects[0]).toMatchObject({ delegates: 1, questionRate: 1, twoQuestionRate: 0, claudeContextMedian: 200, freshQuestionRate: 1 });
    expect(result.tasks[0]).toMatchObject({ taskId: "T", turns: 1, inputTokens: 50, questions: 1 });
    expect(result.unassignedTurns).toBe(1);
  });
});
