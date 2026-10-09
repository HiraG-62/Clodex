import { describe, expect, it } from "vitest";
import { DeliveryNotes } from "./delivery-notes.js";

describe("DeliveryNotes", () => {
  it("人の発言を相手への次の配送にだけ添える", () => {
    const notes = new DeliveryNotes();
    notes.queueHumanContext("claude", "  修正を  続けて ");
    const note = notes.peek("codex");
    expect(note).toContain("修正を 続けて");
    expect(notes.take("codex")).toBe(note);
    expect(notes.peek("codex")).toBe("");
  });

  it("上限中の相手の編集と通知を次の配送まで保持する", () => {
    const notes = new DeliveryNotes();
    notes.beginHold("claude");
    notes.recordPeerFiles("claude", ["a.ts", "b.ts"]);
    notes.queueNotice("claude", "制限中");
    expect(notes.take("claude")).toContain("codex edited: a.ts, b.ts");
    expect(notes.peek("claude")).toBe("");
  });

  it("人の発言を 5 件まで保ち、solo 解除を配送後に消す", () => {
    let released = true;
    const notes = new DeliveryNotes(
      () => released,
      () => {
        released = false;
        return true;
      },
    );
    for (let index = 0; index < 7; index++) notes.queueHumanContext("claude", String(index));
    const note = notes.take("codex");
    expect(note).toContain("(+2 more)");
    expect(note).toContain("Solo mode is off");
    expect(released).toBe(false);
    expect(notes.peek("codex")).toBe("");
  });
});
