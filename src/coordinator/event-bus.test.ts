import { describe, expect, it, vi } from "vitest";
import { EventBus, type CoordinatorEvent } from "./event-bus.js";

const NOW = "2026-10-05T07:00:00.000Z";
const createBus = () => new EventBus(() => new Date(NOW));

describe("EventBus", () => {
  it("publish した event に at を付けて全購読者へ届ける", () => {
    const bus = createBus();
    const a: CoordinatorEvent[] = [];
    const b: CoordinatorEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.publish({ kind: "agent", agent: "claude", event: { type: "text", text: "hi" } });

    const expected = { kind: "agent", agent: "claude", event: { type: "text", text: "hi" }, at: NOW };
    expect(a).toEqual([expected]);
    expect(b).toEqual([expected]);
  });

  it("unsubscribe 後は届かない", () => {
    const bus = createBus();
    const received: CoordinatorEvent[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));
    unsubscribe();
    bus.publish({ kind: "agent", agent: "codex", event: { type: "exit", code: 0 } });
    expect(received).toEqual([]);
  });

  it("購読者の例外は他の購読者と publish 元に波及しない", () => {
    const onError = vi.fn();
    const bus = new EventBus(() => new Date(NOW), onError);
    const received: CoordinatorEvent[] = [];
    bus.subscribe(() => { throw new Error("broken subscriber"); });
    bus.subscribe((e) => received.push(e));

    expect(() => bus.publish({ kind: "agent", agent: "claude", event: { type: "exit", code: 0 } })).not.toThrow();
    expect(received).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "broken subscriber" }));
  });

  it("エラー報告処理が例外を投げても配送は続く", () => {
    const bus = new EventBus(() => new Date(NOW), () => { throw new Error("reporter broken"); });
    const received: CoordinatorEvent[] = [];
    bus.subscribe(() => { throw new Error("broken subscriber"); });
    bus.subscribe((e) => received.push(e));
    expect(() => bus.publish({ kind: "agent", agent: "claude", event: { type: "exit", code: 0 } })).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it("購読中に購読解除されても、その publish の残りの配送は続く", () => {
    const bus = createBus();
    const received: string[] = [];
    const unsubscribeFirst = bus.subscribe(() => { received.push("first"); unsubscribeSecond(); });
    const unsubscribeSecond = bus.subscribe(() => received.push("second"));
    bus.publish({ kind: "agent", agent: "claude", event: { type: "exit", code: 0 } });
    expect(received).toEqual(["first", "second"]);
    unsubscribeFirst();
  });

  it("formal message を流せる", () => {
    const bus = createBus();
    const received: CoordinatorEvent[] = [];
    bus.subscribe((e) => received.push(e));
    const message = {
      id: "msg_1", from: "claude", to: "codex", type: "QUESTION", taskId: "T-1", body: "?",
      repository: "C:\\dev\\app", createdAt: NOW,
    } as const;
    bus.publish({ kind: "message", message });
    expect(received).toEqual([{ kind: "message", message, at: NOW }]);
  });
});
