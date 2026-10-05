import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../web/client/timeline.js";
import { advanceTerminalFeed, cursorSlices, editInput, formatMarkdown, formatTimelineItem } from "./terminal-layout.js";

const labels = {
  you: "あなた", working: "作業中", completed: "完了", failed: "失敗", interrupted: "中断",
  steps: "作業 {count} 件", message: "メッセージ", notice: "通知", error: "エラー", output: "出力",
};

describe("advanceTerminalFeed", () => {
  it("完了した項目だけを一度 Static へ送り、作業中は残す", () => {
    const start = advanceTerminalFeed({ timeline: [], completed: [] }, {
      type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: "2026-01-01T00:00:00Z", event: { type: "turn_started" } },
    }, false);
    expect(start.completed).toEqual([]);
    expect(start.timeline).toHaveLength(1);
    const done = advanceTerminalFeed(start, {
      type: "event", seq: 2, event: { kind: "agent", agent: "claude", at: "2026-01-01T00:00:01Z", event: { type: "turn", result: { status: "completed", text: "完了" } } },
    }, true);
    expect(done.completed).toHaveLength(1);
    expect(done.completed[0]?.expanded).toBe(true);
    expect(done.timeline).toEqual([]);
  });

  it("連続した output は個別に書き出す", () => {
    const first = advanceTerminalFeed({ timeline: [], completed: [] }, { type: "output", seq: 1, text: "a" }, false);
    const second = advanceTerminalFeed(first, { type: "output", seq: 2, text: "b" }, false);
    expect(second.completed.map(({ item }) => item.kind === "output" ? item.text : "")).toEqual(["a", "b"]);
  });
});

describe("formatMarkdown", () => {
  it("見出し・太字・code・リスト・コードブロックを分類する", () => {
    expect(formatMarkdown("# 見出し\n**太字** と `code`\n- 箇条書き\n1. 番号\n```ts\nconst x = 1\n```"))
      .toMatchObject([
        { kind: "heading" }, { kind: "paragraph" }, { kind: "bullet" }, { kind: "ordered" }, { kind: "code", language: "ts" },
      ]);
    expect(formatMarkdown("**太字** と `code`")[0]?.parts.map(({ style }) => style)).toEqual(["bold", "plain", "code"]);
  });
});

describe("formatTimelineItem", () => {
  it("ターンと formal message の見出しと本文を組み立てる", () => {
    const turn: TimelineItem = { kind: "turn", id: "t", agent: "codex", at: "2026-01-01T00:00:00Z", status: "completed",
      plan: "調べます", steps: [{ kind: "tool", name: "Read", input: "a.ts" }], text: "終わりました" };
    expect(formatTimelineItem(turn, labels, false)).toMatchObject({ color: "#4b6fa5", title: "Codex · 完了", plan: "調べます", stepsLabel: "作業 1 件", body: "終わりました" });
    const message: TimelineItem = { kind: "message", id: "m", at: "2026-01-01T00:00:00Z", message: {
      id: "x", from: "claude", to: "codex", type: "DELEGATE", taskId: "T-1", body: "実装して", repository: "r", createdAt: "2026-01-01T00:00:00Z",
    } };
    expect(formatTimelineItem(message, labels, false)).toMatchObject({ title: "Claude → Codex", tag: "DELEGATE · T-1", body: "実装して" });
  });
});

describe("editInput", () => {
  it("移動・挿入・削除・行頭と行末を扱う", () => {
    const left = editInput({ text: "ab\ncd", cursor: 4 }, { kind: "left" });
    expect(left).toEqual({ text: "ab\ncd", cursor: 3 });
    expect(editInput(left, { kind: "insert", text: "X" })).toEqual({ text: "ab\nXcd", cursor: 4 });
    expect(editInput({ text: "ab\ncd", cursor: 4 }, { kind: "home" })).toEqual({ text: "ab\ncd", cursor: 3 });
    expect(editInput({ text: "ab\ncd", cursor: 4 }, { kind: "end" })).toEqual({ text: "ab\ncd", cursor: 5 });
    expect(editInput({ text: "abc", cursor: 2 }, { kind: "backspace" })).toEqual({ text: "ac", cursor: 1 });
    expect(editInput({ text: "abc", cursor: 2 }, { kind: "delete" })).toEqual({ text: "ab", cursor: 2 });
    expect(cursorSlices({ text: "ab\ncd", cursor: 3 })).toEqual({ before: "ab\n", at: "c", after: "d" });
    expect(cursorSlices({ text: "ab\ncd", cursor: 2 })).toEqual({ before: "ab", at: " ", after: "\ncd" });
  });
});
