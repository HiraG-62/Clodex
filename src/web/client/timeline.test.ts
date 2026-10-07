import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../agents/agent-adapter.js";
import type { FeedItem } from "../web-feed.js";
import { rebuildTimeline, applyFeedItem, withStartingTurns, type TimelineItem } from "./timeline.js";

const AT = "2026-10-05T12:00:00.000Z";
let seq = 0;
const agent = (name: "claude" | "codex", event: AgentEvent): FeedItem =>
  ({ type: "event", seq: ++seq, event: { kind: "agent", agent: name, event, at: AT } });
const human = (name: "claude" | "codex", text: string): FeedItem =>
  ({ type: "event", seq: ++seq, event: { kind: "human", agent: name, text, at: AT } });
const output = (text: string): FeedItem => ({ type: "output", seq: ++seq, text });
const run = (items: FeedItem[]) => items.reduce<TimelineItem[]>(applyFeedItem, []);

describe("withStartingTurns", () => {
  it("human の後は起動中を出し、turn_started で置き換える", () => {
    const items = run([human("codex", "実装")]);
    expect(withStartingTurns(items, [{ id: "codex", status: "idle" }], AT).at(-1)).toMatchObject({ kind: "starting", agent: "codex", at: AT });
    const started = applyFeedItem(items, agent("codex", { type: "turn_started" }));
    expect(withStartingTurns(started, [{ id: "codex", status: "busy" }], AT)).toEqual(started);
    expect(items).toHaveLength(1);
  });
  it("state だけの起動中と両 Agent の同時起動を表示する", () => {
    expect(withStartingTurns([], [{ id: "claude", status: "starting" }, { id: "codex", status: "starting" }], AT)).toHaveLength(2);
  });
  it("割り込み・失敗・停止・完了済みの履歴に仮ターンを残さない", () => {
    const sent = run([human("codex", "実装")]);
    expect(withStartingTurns(sent, [{ id: "codex", status: "stopped" }], AT)).toEqual(sent);
    const failed = applyFeedItem(sent, agent("codex", { type: "error", message: "起動失敗" }));
    expect(withStartingTurns(failed, [{ id: "codex", status: "idle" }], AT)).toEqual(failed);
    const done = run([human("codex", "実装"), agent("codex", { type: "turn_started" }), agent("codex", { type: "turn", result: { status: "completed", text: "完了" } })]);
    expect(withStartingTurns(done, [{ id: "codex", status: "idle" }], AT)).toEqual(done);
    const steer = [{ kind: "human" as const, id: "steer", agent: "codex" as const, text: "修正", at: AT, steer: true }];
    expect(withStartingTurns(steer, [{ id: "codex", status: "busy" }], AT)).toEqual(steer);
  });
});

describe("applyFeedItem", () => {
  it("reset でログを空にする", () => {
    expect(applyFeedItem(run([output("a")]), { type: "reset" })).toEqual([]);
  });

  it("人間の入力と、Agent のターン（作業と最終応答）を組み立てる", () => {
    const timeline = run([
      human("claude", "直して"),
      agent("claude", { type: "turn_started" }),
      agent("claude", { type: "text", text: "確認します。" }),
      agent("claude", { type: "tool", name: "Read", input: "a.ts" }),
      agent("claude", { type: "text", text: "直しました。" }),
      agent("claude", { type: "turn", result: { status: "completed", text: "直しました。" } }),
    ]);
    expect(timeline).toEqual([
      { kind: "human", id: expect.any(String), at: AT, agent: "claude", text: "直して" },
      {
        kind: "turn", id: expect.any(String), at: AT, agent: "claude", status: "completed", text: "直しました。",
        // 最初の発言は方針。最終応答と同じ最後の発言は作業から外す
        plan: "確認します。",
        steps: [{ kind: "tool", name: "Read", input: "a.ts" }],
      },
    ]);
  });

  it("発言が最終応答だけのターンは方針を出さない", () => {
    const timeline = run([
      agent("codex", { type: "turn_started" }),
      agent("codex", { type: "text", text: "完了しました。" }),
      agent("codex", { type: "turn", result: { status: "completed", text: "完了しました。" } }),
    ]);
    expect(timeline).toMatchObject([{ kind: "turn", status: "completed", text: "完了しました。", steps: [] }]);
    expect(timeline[0]).not.toHaveProperty("plan");
  });

  it("tool の後の最初の発言も方針にし、2 つ目以降の発言は作業に入れる", () => {
    const timeline = run([
      agent("claude", { type: "turn_started" }),
      agent("claude", { type: "tool", name: "Read", input: "a.ts" }),
      agent("claude", { type: "text", text: "方針です。" }),
      agent("claude", { type: "text", text: "途中です。" }),
    ]);
    expect(timeline).toMatchObject([{
      kind: "turn", status: "working", plan: "方針です。",
      steps: [{ kind: "tool", name: "Read", input: "a.ts" }, { kind: "say", text: "途中です。" }],
    }]);
  });

  it("両 Agent のターンが並行しても、それぞれのターンに振り分ける", () => {
    const timeline = run([
      agent("claude", { type: "turn_started" }),
      agent("codex", { type: "turn_started" }),
      agent("claude", { type: "tool", name: "Read", input: "a" }),
      agent("codex", { type: "tool", name: "command", input: "pnpm test" }),
      agent("codex", { type: "turn", result: { status: "completed", text: "ok" } }),
    ]);
    expect(timeline.map((i) => i.kind === "turn" && [i.agent, i.status, i.steps.length])).toEqual([
      ["claude", "working", 1], ["codex", "completed", 1],
    ]);
  });

  it("ターンの開始を受け取る前の作業も、新しいターンとして受け止める", () => {
    const timeline = run([agent("codex", { type: "tool", name: "command", input: "ls" })]);
    expect(timeline).toMatchObject([{ kind: "turn", agent: "codex", status: "working" }]);
  });

  it("interrupted / failed のターン", () => {
    const timeline = run([
      agent("claude", { type: "turn_started" }),
      agent("claude", { type: "turn", result: { status: "interrupted", text: "" } }),
    ]);
    expect(timeline).toMatchObject([{ kind: "turn", status: "interrupted", text: "" }]);
  });

  it("Agent 間の message は envelope 付きで、通知・エラー・compact も項目にする", () => {
    const message = {
      id: "msg_1", from: "claude", to: "codex", type: "DELEGATE", taskId: "T", body: "b", repository: "C:\\app", createdAt: AT,
    } as const;
    const timeline = run([
      { type: "event", seq: ++seq, event: { kind: "message", message, at: AT }, envelope: "FULL" },
      { type: "event", seq: ++seq, event: { kind: "notice", text: "ahead of pace", at: AT } },
      agent("codex", { type: "error", message: "boom" }),
      agent("claude", { type: "compacted" }),
    ]);
    expect(timeline).toMatchObject([
      { kind: "message", message, envelope: "FULL" },
      { kind: "notice", text: "ahead of pace" },
      { kind: "error", agent: "codex", text: "boom" },
      { kind: "notice", text: "claude: compacted" },
    ]);
  });

  it("続けて届いたコマンドの出力は 1 つにまとめる", () => {
    const timeline = run([output("a"), output("b"), human("claude", "x"), output("c")]);
    expect(timeline.filter((i) => i.kind === "output").map((i) => i.kind === "output" && i.text)).toEqual(["a\nb", "c"]);
  });

  it("状態だけの event は項目にしない", () => {
    expect(run([
      agent("claude", { type: "session", sessionId: "s" }),
      agent("claude", { type: "rate_limit" }),
      agent("claude", { type: "context", tokens: 1 }),
      agent("claude", { type: "exit", code: 0 }),
      { type: "state", state: { project: "C:\app", primary: "claude", roles: {}, agents: [], conversations: [], pendingInputs: [], questions: [], processes: [] } },
    ])).toEqual([]);
  });

  it("変更した項目だけ新しいオブジェクトにする（描画の差分に使う）", () => {
    const first = run([human("claude", "x"), agent("claude", { type: "turn_started" })]);
    const next = applyFeedItem(first, agent("claude", { type: "tool", name: "Read", input: "a" }));
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
  });
});

describe("applyFeedItem の割り込み", () => {
  it("人間の steer の入力に印を付ける", () => {
    const item: FeedItem = { type: "event", seq: 900, event: { kind: "human", agent: "codex", text: "fix", steer: true, at: AT } };
    expect(applyFeedItem([], item)).toMatchObject([{ kind: "human", text: "fix", steer: true }]);
  });
});

it("toast は timeline を変更しない", () => {
  const items = applyFeedItem([], { type: "output", seq: 1, text: "ログ" });
  expect(applyFeedItem(items, { type: "toast", text: "通知", level: "info" })).toBe(items);
});

it("前の履歴を足して再構築するとページをまたぐターンが一つにまとまる", () => {
  const start = { type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: "now", event: { type: "turn_started" } } } as const;
  const end = { type: "event", seq: 2, event: { kind: "agent", agent: "claude", at: "now", event: { type: "turn", result: { status: "completed", text: "完了" } } } } as const;
  const result = rebuildTimeline([start, end], applyFeedItem);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: "e1", status: "completed", text: "完了" });
  expect(rebuildTimeline([], applyFeedItem)).toEqual([]);
});

it("質問と回答を同じカードにまとめ、他のカードを変更しない", () => {
  const questions = [{ question: "選択", options: [{ label: "A" }, { label: "B" }] }];
  const first = run([output("ログ"), { type: "event", seq: 20, event: { kind: "question", id: "q1", agent: "codex", questions, at: AT } }]);
  expect(first[1]).toEqual({ kind: "question", id: "q1", agent: "codex", questions, at: AT });
  const answered = applyFeedItem(first, { type: "event", seq: 21, event: { kind: "answer", id: "q1", agent: "codex", answers: [["A"]], at: AT } });
  expect(answered).toHaveLength(2);
  expect(answered[1]).toMatchObject({ id: "q1", answers: [["A"]] });
  expect(answered[0]).toBe(first[0]);
  expect(applyFeedItem([], { type: "event", seq: 21, event: { kind: "answer", id: "missing", agent: "codex", answers: [["A"]], at: AT } })).toEqual([]);
});
