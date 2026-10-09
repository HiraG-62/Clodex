import { expect, it } from "vitest";
import { pendingRows } from "./pending-rows.js";

it("人間の入力と Agent 間メッセージを行にし、待機中の宛先に再開時刻を添える", () => {
  const now = new Date(2026, 9, 9, 10, 0);
  const today = new Date(2026, 9, 9, 11, 5).toISOString();
  const tomorrow = new Date(2026, 9, 10, 1, 30).toISOString();
  expect(
    pendingRows(
      [{ id: "in1", agent: "codex", text: "確認\n\nReferenced files:\n- a.ts" }],
      [{ id: "msg_1", agent: "codex", from: "claude", type: "DELEGATE", taskId: "T", text: "実装\n詳細" }],
      [{ id: "codex", holdUntil: today }],
      "\n\nReferenced files:\n",
      now,
    ),
  ).toEqual([
    { kind: "input", id: "in1", agent: "codex", text: "確認", holdTime: "11:05" },
    { kind: "message", id: "msg_1", agent: "codex", from: "claude", type: "DELEGATE", text: "実装", holdTime: "11:05" },
  ]);
  expect(
    pendingRows(
      [],
      [{ id: "msg_2", agent: "claude", from: "codex", type: "QUESTION", taskId: "T", text: "質問" }],
      [{ id: "claude", holdUntil: tomorrow }],
      "x",
      now,
    )[0]?.holdTime,
  ).toBe("10/10 01:30");
});
