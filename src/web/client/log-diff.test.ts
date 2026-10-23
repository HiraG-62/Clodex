import { describe, expect, it } from "vitest";
import { diffTurn, discardMissingOpened } from "./log-diff.js";
import type { TimelineItem } from "./timeline.js";

const turn = (changes: Partial<Extract<TimelineItem, { kind: "turn" }>> = {}): Extract<TimelineItem, { kind: "turn" }> => ({
  kind: "turn",
  id: "t1",
  agent: "claude",
  at: "2026-10-10T00:00:00Z",
  status: "working",
  steps: [],
  text: "",
  ...changes,
});

describe("diffTurn", () => {
  it("既存の本文と tool を再利用し、追加と変更だけを返す", () => {
    const previous = turn({
      steps: [
        { kind: "say", text: "説明 a.png", at: "now" },
        { kind: "tool", name: "Read", input: "a" },
      ],
    });
    const next = {
      ...previous,
      steps: [...previous.steps, { kind: "tool" as const, name: "Read", input: "b" }, { kind: "say" as const, text: "続き", at: "later" }],
    };
    expect(diffTurn(previous, next)).toMatchObject({ replace: false, blocks: [0, 2] });
    const changed = { ...next, steps: [{ kind: "say" as const, text: "説明 b.png", at: "now" }, ...next.steps.slice(1)] };
    expect(diffTurn(next, changed)).toMatchObject({ replace: false, blocks: [1] });
  });
  it("質問の回答は該当カードだけ更新する", () => {
    const question = { kind: "question" as const, id: "q", at: "now", agent: "claude" as const, questions: [{ question: "選択", options: [{ label: "A" }] }] };
    const previous = turn({ questions: [question] });
    const next = { ...previous, questions: [{ ...question, answers: [["A"]] }] };
    expect(diffTurn(previous, next)).toMatchObject({ replace: false, blocks: [0] });
  });
  it("状態が変わったときは見出しも描き直す", () => {
    const previous = turn();
    expect(diffTurn(previous, { ...previous, status: "completed" }).replace).toBe(true);
  });
});

it("消えた項目の開閉状態を消す", () => {
  const opened = new Map([
    ["keep", true],
    ["old", false],
  ]);
  discardMissingOpened(opened, new Set(["keep"]));
  expect([...opened]).toEqual([["keep", true]]);
});
