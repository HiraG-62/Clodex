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
    { kind: "input", id: "in1", agent: "codex", text: "確認", holdTime: "11:05", canSteer: false },
    { kind: "message", id: "msg_1", agent: "codex", from: "claude", type: "DELEGATE", text: "実装", holdTime: "11:05", canSteer: false },
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

it("割り込みは宛先が作業中で上限待機中でない行だけ使える", () => {
  const input = [{ id: "in1", agent: "codex" as const, text: "入力" }];
  expect(pendingRows(input, [], [{ id: "codex", status: "busy" }], "x")[0]?.canSteer).toBe(true);
  expect(pendingRows(input, [], [{ id: "codex", status: "idle" }], "x")[0]?.canSteer).toBe(false);
  expect(pendingRows(input, [], [{ id: "codex", status: "busy", holdUntil: new Date().toISOString() }], "x")[0]?.canSteer).toBe(false);
});

it("割り込み非対応の Agent と新しい session の依頼は割り込めない", () => {
  const busy = [
    { id: "gemini" as const, status: "busy" },
    { id: "codex" as const, status: "busy" },
  ];
  expect(pendingRows([{ id: "in1", agent: "gemini", text: "入力" }], [], busy, "x")[0]?.canSteer).toBe(false);
  const fresh = { id: "msg_1", agent: "codex" as const, from: "claude" as const, type: "DELEGATE" as const, taskId: "T", text: "実装", fresh: true as const };
  expect(pendingRows([], [fresh], busy, "x")[0]?.canSteer).toBe(false);
});
