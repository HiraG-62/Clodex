import { describe, expect, it } from "vitest";
import type { CoordinatorEvent } from "../coordinator/event-bus.js";
import { DEFAULT_RECENT_ITEMS, WebFeed, buildLimitState, type FeedItem, type WebState } from "./web-feed.js";
import { DEFAULT_LIMITS } from "../coordinator/budget-manager.js";

const AT = "2026-10-05T12:00:00.000Z";
const textEvent = (text: string): CoordinatorEvent => ({ kind: "agent", agent: "claude", event: { type: "text", text }, at: AT });
const STATE: WebState = { project: "C:\app", primary: "claude", roles: {}, agents: [], tabs: [], conversations: [], pendingInputs: [], pendingMessages: [], questions: [], processes: [], language: "ja", sandbox: { enabled: false, ready: false }, limitsUnlimited: false, limits: { messages: { value: 8, default: 8 }, reviews: { value: 3, default: 3 }, delegations: { value: 4, default: 4 }, depth: { value: 2, default: 2 } } };

describe("WebFeed", () => {
  it("limits の既定値は設定ファイルを優先し、実行中の上書きとは分ける", () => {
    expect(buildLimitState({ ...DEFAULT_LIMITS, maxMessagesPerChain: 5 }, { maxMessagesPerChain: 12 })).toEqual({
      messages: { value: 5, default: 12 }, reviews: { value: 3, default: 3 },
      delegations: { value: 4, default: 4 }, depth: { value: 2, default: 2 },
    });
  });
  it("sandbox・既定値を含む limits・language を最新 state として配信する", () => {
    const feed = new WebFeed();
    const received: FeedItem[] = [];
    feed.subscribe(item => received.push(item));
    const state: WebState = { ...STATE, sandbox: { enabled: true, ready: true }, language: "ja",
      limits: { messages: { value: 3, default: 10 }, reviews: { value: 2, default: 2 }, delegations: { value: 4, default: 4 }, depth: { value: 1, default: 1 } } };
    feed.publishState(state);
    expect(feed.latestState()).toEqual(state);
    expect(received).toEqual([{ type: "state", state }]);
  });
  it("output の command を配信・保存用コールバック・履歴に保持する", () => {
    const recorded: FeedItem[] = [];
    const received: FeedItem[] = [];
    const feed = new WebFeed(DEFAULT_RECENT_ITEMS, (item) => recorded.push(item));
    feed.subscribe((item) => received.push(item));
    feed.publishOutput("$ run", { id: 1, phase: "start" });
    feed.publishOutput("error: normal output");
    feed.publishOutput("exit 0 (1s)", { id: 1, phase: "exit" });
    expect(received).toEqual([
      { type: "output", seq: 1, text: "$ run", command: { id: 1, phase: "start" } },
      { type: "output", seq: 2, text: "error: normal output" },
      { type: "output", seq: 3, text: "exit 0 (1s)", command: { id: 1, phase: "exit" } },
    ]);
    expect(recorded).toEqual(received);
    expect(feed.recent()).toEqual(received);
  });
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

it("toast は購読者だけに届き履歴にも保存にも入らない", () => {
  const recorded: FeedItem[] = [];
  const received: FeedItem[] = [];
  const feed = new WebFeed(DEFAULT_RECENT_ITEMS, (item) => recorded.push(item));
  feed.subscribe((item) => received.push(item));
  feed.publishToast("切り替え", "info");
  feed.publishToast("注意", "warn");
  expect(received).toEqual([{ type: "toast", text: "切り替え", level: "info" }, { type: "toast", text: "注意", level: "warn" }]);
  expect(feed.recent()).toEqual([]);
  expect(recorded).toEqual([]);
});

it("初回と replace は直近 200 件だけを配り、前の履歴も保持する", () => {
  const feed = new WebFeed();
  for (let i = 1; i <= 1001; i++) feed.publishOutput(String(i));
  expect(feed.recent()).toHaveLength(200);
  expect(feed.recent()[0]?.seq).toBe(802);
  expect(feed.before(802).items).toHaveLength(200);
  const received: FeedItem[] = [];
  feed.subscribe((item) => received.push(item));
  feed.replace(Array.from({ length: 500 }, (_, seq) => ({ type: "output", seq, text: String(seq) })));
  expect(received).toHaveLength(201);
  expect(received[0]).toEqual({ type: "reset" });
  expect(received.slice(1)).toEqual(feed.recent());
  const previous = feed.before(feed.recent()[0]!.seq);
  expect(previous.items).toHaveLength(200);
  expect(previous.hasMore).toBe(true);
  expect(feed.before(previous.items[0]!.seq).items).toHaveLength(100);
  expect(feed.before(previous.items[0]!.seq).hasMore).toBe(false);
});

it("before は境界を含めず limit を 1〜200 に収める", () => {
  const feed = new WebFeed();
  for (let i = 1; i <= 500; i++) feed.publishOutput(String(i));
  expect(feed.before(4, 2)).toEqual({ items: [{ type: "output", seq: 2, text: "2" }, { type: "output", seq: 3, text: "3" }], hasMore: true });
  expect(feed.before(1)).toEqual({ items: [], hasMore: false });
  expect(feed.before(2, 0)).toEqual({ items: [{ type: "output", seq: 1, text: "1" }], hasMore: false });
  expect(feed.before(500, -1).items).toHaveLength(1);
  expect(feed.before(500, 999).items).toHaveLength(200);
  expect(feed.before(500, Number.NaN).items).toHaveLength(200);
});
