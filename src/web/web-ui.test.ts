import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../coordinator/event-bus.js";
import { WebFeed, type FeedItem, type WebState } from "./web-feed.js";
import { connectWebFeed, historyItemOf } from "./web-ui.js";

const STATE: WebState = { project: "C:\\app", primary: "claude", roles: {}, agents: [], conversations: [], pendingInputs: [], processes: [] };
const message = {
  id: "msg_1", from: "claude", to: "codex", type: "QUESTION", taskId: "T", body: "?", repository: "C:\\app", createdAt: "x",
} as const;

describe("connectWebFeed", () => {
  it("接続時に状態を送り、Event Bus の event を feed に流す。message には envelope を付ける", () => {
    const bus = new EventBus();
    const feed = new WebFeed();
    connectWebFeed(bus, feed, () => STATE);
    expect(feed.latestState()).toEqual(STATE);

    bus.publish({ kind: "message", message });
    const [item] = feed.recent();
    expect(item).toMatchObject({ type: "event", event: { kind: "message" } });
    expect(item?.type === "event" && item.envelope).toContain("[Clodex] Message msg_1 from claude");
  });

  it("短い間隔の変化はまとめて 1 回だけ状態を送る", () => {
    vi.useFakeTimers();
    try {
      const bus = new EventBus();
      const feed = new WebFeed();
      let primary: WebState["primary"] = "claude";
      const { refreshState } = connectWebFeed(bus, feed, () => ({ ...STATE, primary }));
      const states: FeedItem[] = [];
      feed.subscribe((i) => { if (i.type === "state") states.push(i); });

      bus.publish({ kind: "notice", text: "a" });
      primary = "codex";
      refreshState();
      bus.publish({ kind: "notice", text: "b" });
      expect(states).toEqual([]);
      vi.runAllTimers();
      expect(states).toEqual([{ type: "state", state: { ...STATE, primary: "codex" } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("agent の状態専用 event は feed に保存せず state だけ更新する", () => {
    vi.useFakeTimers();
    try {
      const bus = new EventBus();
      const feed = new WebFeed();
      const states: FeedItem[] = [];
      connectWebFeed(bus, feed, () => STATE);
      feed.subscribe((item) => { if (item.type === "state") states.push(item); });
      for (const event of [
        { type: "session", sessionId: "s" } as const,
        { type: "context", tokens: 12 } as const,
        { type: "rate_limit", weekly: { usedPercent: 10, resetsAt: 1 } } as const,
        { type: "exit", code: 0 } as const,
      ]) bus.publish({ kind: "agent", agent: "claude", event });
      expect(feed.recent()).toEqual([]);
      vi.runAllTimers();
      expect(states).toHaveLength(1);
      bus.publish({ kind: "agent", agent: "claude", event: { type: "turn_started" } });
      expect(feed.recent()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("historyItemOf", () => {
  it("feed に流す event は保存する形にし、状態専用の event は undefined", () => {
    expect(historyItemOf({ kind: "message", message, at: "x" })).toMatchObject({ type: "event", seq: 0, envelope: expect.stringContaining("msg_1") });
    expect(historyItemOf({ kind: "agent", agent: "claude", event: { type: "context", tokens: 1 }, at: "x" })).toBeUndefined();
  });
});
