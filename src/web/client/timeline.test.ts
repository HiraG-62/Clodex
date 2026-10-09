import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../agents/agent-adapter.js";
import type { AgentMessage } from "../../protocol/messages.js";
import type { FeedItem } from "../web-feed.js";
import { rebuildTimeline, applyFeedItem, withWorkingTurnsLast, withStartingTurns, withSubagentRows, workingFeed, type TimelineItem } from "./timeline.js";

const AT = "2026-10-05T12:00:00.000Z";
const LATER = "2026-10-05T12:05:00.000Z";
let seq = 0;
const agent = (name: "claude" | "codex", event: AgentEvent, at = AT): FeedItem =>
  ({ type: "event", seq: ++seq, event: { kind: "agent", agent: name, event, at } });
const human = (name: "claude" | "codex", text: string): FeedItem =>
  ({ type: "event", seq: ++seq, event: { kind: "human", agent: name, text, at: AT } });
const output = (text: string): FeedItem => ({ type: "output", seq: ++seq, text });
const formal = (from: "claude" | "codex", body: string, auto = false): FeedItem => {
  const message: AgentMessage = {
    id: `msg_${++seq}`, from, to: from === "claude" ? "codex" : "claude", type: "DELEGATE", taskId: "T",
    body, repository: "C:\\app", createdAt: AT, ...(auto ? { auto: true } : {}),
  };
  return { type: "event", seq, event: { kind: "message", message, at: AT }, envelope: `封筒: ${body}` };
};
const run = (items: FeedItem[]) => items.reduce<TimelineItem[]>(applyFeedItem, []);

describe("withStartingTurns", () => {
  it("配送待ちや busy 中の human は、取り消して idle になっても仮ターンにしない", () => {
    const items = run([human("codex", "後で実装")]);
    for (const status of ["busy", "idle"] as const) {
      const queued = withStartingTurns(items, [{ id: "codex", status }], AT, [{ agent: "codex" }]);
      expect(queued.some((item) => item.kind === "starting")).toBe(false);
      const saved = queued.filter((item): item is TimelineItem => item.kind !== "starting");
      const canceled = withStartingTurns(saved, [{ id: "codex", status: "idle" }], AT, []);
      expect(canceled.some((item) => item.kind === "starting")).toBe(false);
      const edited = applyFeedItem(saved, human("codex", "編集して再送"));
      expect(withStartingTurns(edited, [{ id: "codex", status: "idle" }], AT).at(-1)?.kind).toBe("starting");
    }
    const busy = withStartingTurns(items, [{ id: "codex", status: "busy" }], AT);
    expect(busy.some((item) => item.kind === "starting")).toBe(false);
  });
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

describe("withSubagentRows", () => {
  const running = [{ id: "sub-1", description: "調査" }, { id: "sub-2", description: "" }];

  it("待機中の Agent ごとに、ログ末尾へ表示用の行を足す", () => {
    const items = run([output("履歴")]);
    const result = withSubagentRows(items, [
      { id: "claude", status: "idle", subagents: running },
      { id: "codex", status: "idle", subagents: [{ id: "sub-x", description: "/root/review" }] },
    ]);
    expect(result.slice(-2)).toEqual([
      { kind: "subagents", id: "subagents-claude", agent: "claude", running },
      { kind: "subagents", id: "subagents-codex", agent: "codex", running: [{ id: "sub-x", description: "/root/review" }] },
    ]);
    expect(items).toHaveLength(1);
  });

  it("作業中・起動中・空の一覧では行を足さない", () => {
    const result = withSubagentRows([], [
      { id: "claude", status: "busy", subagents: running },
      { id: "codex", status: "starting", subagents: running },
    ]);
    expect(result).toEqual([]);
    expect(withSubagentRows([], [{ id: "claude", status: "idle", subagents: [] }])).toEqual([]);
  });

  it("起動中の行がある Agent には重ねない", () => {
    const starting = withStartingTurns([], [{ id: "claude", status: "starting" }], AT);
    expect(withSubagentRows(starting, [{ id: "claude", status: "idle", subagents: running }])).toEqual(starting);
  });
});

describe("withWorkingTurnsLast", () => {
  it("作業中に届いた人の入力と message より、作業中のターンを下に表示する", () => {
    const items = run([agent("claude", { type: "turn_started" }), human("codex", "確認"), formal("codex", "依頼")]);
    expect(withWorkingTurnsLast(items).map((item) => item.kind)).toEqual(["human", "message", "turn"]);
    expect(items[0]?.kind).toBe("turn");
  });

  it("両 Agent の作業中は開始順に並べる", () => {
    const items = run([agent("claude", { type: "turn_started" }), agent("codex", { type: "turn_started" }), human("claude", "追加")]);
    const display = withWorkingTurnsLast(items);
    expect(display.map((item) => item.kind)).toEqual(["human", "turn", "turn"]);
    expect(display.slice(1).map((item) => "agent" in item && item.agent)).toEqual(["claude", "codex"]);
  });

  it("末尾は作業中 → 起動中 → subagent の行にする", () => {
    const items = run([agent("claude", { type: "turn_started" }), human("codex", "追加")]);
    const agents = [
      { id: "claude" as const, status: "idle" as const, subagents: [{ id: "sub", description: "調査" }] },
      { id: "codex" as const, status: "starting" as const, subagents: [] },
    ];
    const display = withSubagentRows(withStartingTurns(withWorkingTurnsLast(items), agents, AT), agents);
    expect(display.map((item) => item.kind)).toEqual(["human", "turn", "starting", "subagents"]);
  });
});

describe("applyFeedItem", () => {
  it("作業中の送信元ターンへ複数の message を順に入れる", () => {
    const timeline = run([
      agent("claude", { type: "turn_started" }),
      formal("claude", "依頼 1"), formal("claude", "依頼 2"),
      agent("claude", { type: "turn", result: { status: "completed", text: "依頼しました" } }),
    ]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "turn", messages: [
      { message: { body: "依頼 1" }, envelope: "封筒: 依頼 1" },
      { message: { body: "依頼 2" }, envelope: "封筒: 依頼 2" },
    ] });
  });

  it("自動 RESULT は直前に終わった送信元ターンへ入れる", () => {
    const timeline = run([
      agent("codex", { type: "turn_started" }),
      agent("codex", { type: "turn", result: { status: "completed", text: "実装しました" } }),
      formal("codex", "自動の結果", true),
    ]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "turn", messages: [{ message: { body: "自動の結果", auto: true } }] });
  });

  it("送信元のターンが無い message と ACK は独立した項目にする", () => {
    const before = run([formal("claude", "単独")]);
    expect(before).toMatchObject([{ kind: "message", message: { body: "単独" } }]);
    const ack = formal("claude", "確認");
    if (ack.type !== "event" || ack.event.kind !== "message") throw new Error("message が必要");
    const timeline = run([agent("claude", { type: "turn_started" }), { ...ack, event: { ...ack.event, message: { ...ack.event.message, type: "ACK" } } }]);
    expect(timeline.map((item) => item.kind)).toEqual(["turn", "message"]);
  });

  it("ターンが終わっても message と方針を同じ枠に残す", () => {
    const timeline = run([
      agent("claude", { type: "turn_started" }),
      agent("claude", { type: "text", text: "調べます" }),
      formal("claude", "依頼"),
      human("claude", "割り込み"),
      agent("claude", { type: "turn", result: { status: "completed", text: "依頼しました" } }, LATER),
    ]);
    expect(timeline.map((item) => item.kind)).toEqual(["human", "turn"]);
    expect(timeline[1]).toMatchObject({ kind: "turn", plan: "調べます", text: "依頼しました", messages: [{ message: { body: "依頼" } }] });
  });

  it("履歴を再構築しても message をターンに入れる", () => {
    const history = [agent("claude", { type: "turn_started" }), formal("claude", "依頼"), agent("claude", { type: "turn", result: { status: "completed", text: "完了" } })];
    expect(rebuildTimeline(history as Extract<FeedItem, { type: "event" | "output" }>[], applyFeedItem))
      .toMatchObject([{ kind: "turn", messages: [{ message: { body: "依頼" } }] }]);
  });

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
        plan: "確認します。", planAt: AT,
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

  it("作業中に後ろへ項目が並んだら、終わった枠ごと末尾へ移す", () => {
    const timeline = run([
      agent("claude", { type: "turn_started" }),
      agent("claude", { type: "text", text: "確認します。" }),
      agent("claude", { type: "tool", name: "Read", input: "a.ts" }),
      human("claude", "割り込み"),
      agent("claude", { type: "turn", result: { status: "completed", text: "直しました。" } }, LATER),
    ]);
    expect(timeline).toEqual([
      expect.objectContaining({ kind: "human", text: "割り込み" }),
      { kind: "turn", id: expect.any(String), at: AT, agent: "claude", status: "completed", text: "直しました。",
        plan: "確認します。", planAt: AT, steps: [{ kind: "tool", name: "Read", input: "a.ts" }] },
    ]);
  });

  it("終わった枠は固定され、その後の入力は下に並ぶ", () => {
    const events = [
      agent("claude", { type: "turn_started" }), human("codex", "途中"),
      agent("claude", { type: "turn", result: { status: "completed", text: "完了" } }), human("claude", "次"),
    ];
    const expected = ["途中", "完了", "次"];
    const texts = (items: readonly TimelineItem[]) => items.map((item) => item.kind === "human" || item.kind === "turn" ? item.text : "");
    expect(texts(run(events))).toEqual(expected);
    expect(texts(rebuildTimeline(events as Extract<FeedItem, { type: "event" | "output" }>[], applyFeedItem))).toEqual(expected);
  });

  it("最終応答と同じ方針は重ねず、元の枠を末尾へ移す", () => {
    const timeline = run([
      agent("codex", { type: "turn_started" }),
      agent("codex", { type: "text", text: "完了しました。" }),
      human("codex", "割り込み"),
      agent("codex", { type: "turn", result: { status: "completed", text: "完了しました。" } }, LATER),
    ]);
    expect(timeline).toMatchObject([
      { kind: "human", text: "割り込み" },
      { kind: "turn", at: AT, status: "completed", text: "完了しました。", steps: [] },
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).not.toHaveProperty("plan");
  });

  it("自分の質問・message が後ろでも、終わった枠を末尾へ移す", () => {
    const question: FeedItem = { type: "event", seq: ++seq, event: {
      kind: "question", id: "q1", agent: "claude", at: AT, questions: [{ question: "どれ？", options: [{ label: "A" }, { label: "B" }] }],
    } };
    const message = (from: "claude" | "codex"): FeedItem => ({ type: "event", seq: ++seq, event: { kind: "message", at: AT, message: {
      id: `msg_${seq}`, from, to: from === "claude" ? "codex" : "claude", type: "DELEGATE", taskId: "T", body: "実装", repository: "C:\\r", createdAt: AT,
    } } });
    const timeline = run([
      agent("claude", { type: "turn_started" }),
      agent("claude", { type: "text", text: "確認します。" }),
      question,
      message("claude"),
      agent("claude", { type: "turn", result: { status: "completed", text: "選んでください。" } }, LATER),
    ]);
    expect(timeline).toMatchObject([
      { kind: "question", id: "q1" },
      { kind: "turn", agent: "claude", status: "completed", text: "選んでください。", plan: "確認します。", messages: [{ message: { body: "実装" } }] },
    ]);
    expect(timeline).toHaveLength(2);

    const replied = run([
      agent("claude", { type: "turn_started" }),
      agent("claude", { type: "text", text: "確認します。" }),
      message("codex"),
      agent("claude", { type: "turn", result: { status: "completed", text: "完了" } }, LATER),
    ]);
    expect(replied).toHaveLength(2);
    expect(replied[1]).toMatchObject({ kind: "turn", text: "完了" });
  });

  it("後ろが作業中のターンだけでも、終わった枠を末尾へ移す", () => {
    const timeline = run([
      agent("claude", { type: "turn_started" }),
      agent("claude", { type: "tool", name: "Read", input: "a" }),
      agent("codex", { type: "turn_started" }),
      agent("claude", { type: "turn", result: { status: "completed", text: "ok" } }),
    ]);
    expect(timeline).toMatchObject([
      { kind: "turn", agent: "codex", status: "working" },
      { kind: "turn", agent: "claude", status: "completed", text: "ok" },
    ]);
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
      { type: "state", state: { project: "C:\app", primary: "claude", roles: {}, agents: [], tabs: [], conversations: [], pendingInputs: [], pendingMessages: [], questions: [], processes: [], language: "ja", sandbox: { enabled: false, ready: false }, limitsUnlimited: false, limits: { messages: { value: 8, default: 8 }, reviews: { value: 3, default: 3 }, delegations: { value: 4, default: 4 }, depth: { value: 2, default: 2 } } } },
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

  it("steer_delivered で同じ steerId の人間の割り込みを届いたにする", () => {
    const human: FeedItem = { type: "event", seq: 900, event: { kind: "human", agent: "codex", text: "fix", steer: true, steerId: "s-1", at: AT } };
    const other: FeedItem = { type: "event", seq: 901, event: { kind: "human", agent: "codex", text: "next", steer: true, steerId: "s-2", at: AT } };
    const delivered: FeedItem = { type: "event", seq: 902, event: { kind: "agent", agent: "codex", at: AT, event: { type: "steer_delivered", steerId: "s-1" } } };
    const items = [human, other, delivered].reduce(applyFeedItem, []);
    expect(items).toMatchObject([{ text: "fix", steerId: "s-1", delivered: true }, { text: "next", steerId: "s-2" }]);
    expect(items[1]).not.toHaveProperty("delivered");
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

it("同じ Agent のターンが始まったら、その Agent の作業中のターンを中断にする", () => {
  const items = run([
    agent("claude", { type: "turn_started" }),
    agent("codex", { type: "turn_started" }),
    agent("claude", { type: "turn_started" }),
    agent("claude", { type: "turn", result: { status: "completed", text: "続き" } }),
  ]);
  const turns = items.flatMap((item) => item.kind === "turn" ? [`${item.agent}:${item.status}`] : []);
  expect(turns).toEqual(["codex:working", "claude:interrupted", "claude:completed"]);
});

describe("workingFeed", () => {
  const at = (second: number) => `2026-10-05T12:00:${String(second).padStart(2, "0")}.000Z`;
  it("作業中のターンの発言を時系列に並べ、ターンが変わるところに見出しを挟む（方針の直前の見出しには方針を重ねない）", () => {
    const items = run([
      agent("claude", { type: "turn_started" }, at(0)),
      agent("claude", { type: "text", text: "設計する" }, at(1)),
      agent("codex", { type: "turn_started" }, at(2)),
      agent("codex", { type: "text", text: "実装する" }, at(3)),
      agent("claude", { type: "tool", name: "Read", input: "a.ts" }, at(4)),
      agent("claude", { type: "text", text: "読んだ" }, at(5)),
      agent("codex", { type: "text", text: "テストを書いた" }, at(6)),
      agent("codex", { type: "text", text: "通った" }, at(7)),
    ]);
    const [claude, codex] = items;
    expect(workingFeed(items)).toEqual([
      { kind: "head", turnId: claude!.id, agent: "claude", at: at(0) },
      { kind: "say", agent: "claude", text: "設計する" },
      { kind: "head", turnId: codex!.id, agent: "codex", at: at(2) },
      { kind: "say", agent: "codex", text: "実装する" },
      { kind: "head", turnId: claude!.id, agent: "claude", at: at(0), plan: "設計する" },
      { kind: "say", agent: "claude", text: "読んだ" },
      { kind: "head", turnId: codex!.id, agent: "codex", at: at(2), plan: "実装する" },
      { kind: "say", agent: "codex", text: "テストを書いた" },
      { kind: "say", agent: "codex", text: "通った" },
    ]);
  });
  it("発言の無いターンは見出しだけを出し、終わったターンの見出しには done を付ける", () => {
    const items = run([
      agent("codex", { type: "turn_started" }, at(0)),
      agent("codex", { type: "text", text: "確認する" }, at(1)),
      agent("codex", { type: "text", text: "途中" }, at(2)),
      agent("codex", { type: "turn", result: { status: "completed", text: "完了" } }, at(3)),
      agent("claude", { type: "turn_started" }, at(4)),
    ]);
    expect(workingFeed(items)).toEqual([
      { kind: "head", turnId: items[0]!.id, agent: "codex", at: at(0), done: true },
      { kind: "say", agent: "codex", text: "確認する" },
      { kind: "say", agent: "codex", text: "途中" },
      { kind: "head", turnId: items[1]!.id, agent: "claude", at: at(4) },
    ]);
  });
  it("Agent ごとに直近 2 ターンだけを残し、最終応答だけの項目は数えない", () => {
    const turn = (name: "claude" | "codex", text: string, start: number): FeedItem[] => [
      agent(name, { type: "turn_started" }, at(start)),
      agent(name, { type: "text", text }, at(start + 1)),
      agent(name, { type: "text", text: `${text}の途中` }, at(start + 2)),
      agent(name, { type: "turn", result: { status: "completed", text: `${text}の完了` } }, at(start + 3)),
    ];
    const items = run([
      ...turn("claude", "1", 0),
      ...turn("codex", "A", 4),
      agent("claude", { type: "turn_started" }, at(10)),
      agent("claude", { type: "text", text: "2" }, at(11)),
      human("claude", "割り込み"),
      agent("claude", { type: "turn", result: { status: "completed", text: "2の完了" } }, at(12)),
      ...turn("claude", "3", 20),
    ]);
    const texts = workingFeed(items).filter((entry) => entry.kind === "say").map((entry) => entry.kind === "say" ? entry.text : "");
    expect(texts).toEqual(["A", "Aの途中", "2", "3", "3の途中"]);
    expect(workingFeed(items).filter((entry) => entry.kind === "head").map((entry) => entry.agent)).toEqual(["codex", "claude", "claude"]);
  });
});
