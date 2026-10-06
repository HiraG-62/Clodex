import { describe, expect, it } from "vitest";
import type { CoordinatorEvent } from "../coordinator/event-bus.js";
import { DEFAULT_RECENT_ITEMS, WebFeed, type FeedItem, type WebState } from "./web-feed.js";

const AT = "2026-10-05T12:00:00.000Z";
const textEvent = (text: string): CoordinatorEvent => ({ kind: "agent", agent: "claude", event: { type: "text", text }, at: AT });
const STATE: WebState = { project: "C:\app", primary: "claude", roles: {}, agents: [], conversations: [], pendingInputs: [], processes: [] };

describe("WebFeed", () => {
  it("event と output に通し番号を付けて購読者に配り、直近を保持する", () => {
    const feed = new WebFeed(2);
    const received: FeedItem[] = [];
    feed.subscribe((item) => received.push(item));
    feed.publishEvent(textEvent("a"));
    feed.publishOutput("help line");
    feed.publishEvent(textEvent("b"));

    expect(received).toEqual([
      { type: "event", seq: 1, event: textEvent("a") },
      { type: "output", seq: 2, text: "help line" },
      { type: "event", seq: 3, event: textEvent("b") },
    ]);
    expect(feed.recent().map((i) => i.seq)).toEqual([2, 3]);
  });

  it("replace は reset を配り、読み込んだ項目に新しい通し番号を振り直して保持・配信する", () => {
    const feed = new WebFeed();
    feed.publishOutput("old");
    const received: FeedItem[] = [];
    feed.subscribe((item) => received.push(item));
    feed.replace([{ type: "output", seq: 7, text: "saved" }, { type: "event", seq: 9, event: textEvent("a") }]);

    expect(received).toEqual([
      { type: "reset" },
      { type: "output", seq: 2, text: "saved" },
      { type: "event", seq: 3, event: textEvent("a") },
    ]);
    expect(feed.recent()).toEqual(received.slice(1));
  });

  it("onRecord には新しく publish した項目だけを渡す（replace で読み込んだ項目は渡さない）", () => {
    const recorded: FeedItem[] = [];
    const feed = new WebFeed(DEFAULT_RECENT_ITEMS, (item) => recorded.push(item));
    feed.publishOutput("new");
    feed.replace([{ type: "output", seq: 1, text: "saved" }]);
    feed.publishState(STATE);
    expect(recorded).toEqual([{ type: "output", seq: 1, text: "new" }]);
  });

  it("formal message には envelope を付けられる", () => {
    const feed = new WebFeed();
    const message = {
      id: "msg_1", from: "claude", to: "codex", type: "QUESTION", taskId: "T", body: "?", repository: "C:\\app", createdAt: AT,
    } as const;
    feed.publishEvent({ kind: "message", message, at: AT }, "[Clodex] Message msg_1 from claude");
    expect(feed.recent()[0]).toMatchObject({ envelope: "[Clodex] Message msg_1 from claude" });
  });

  it("state は保持して配るが、直近の履歴には入れない", () => {
    const feed = new WebFeed();
    const received: FeedItem[] = [];
    feed.subscribe((item) => received.push(item));
    feed.publishState(STATE);
    expect(received).toEqual([{ type: "state", state: STATE }]);
    expect(feed.latestState()).toEqual(STATE);
    expect(feed.recent()).toEqual([]);
  });

  it("購読者の例外は他の購読者に波及しない", () => {
    const feed = new WebFeed();
    const received: FeedItem[] = [];
    feed.subscribe(() => { throw new Error("closed"); });
    feed.subscribe((item) => received.push(item));
    expect(() => feed.publishOutput("x")).not.toThrow();
    expect(received).toHaveLength(1);
  });
});
