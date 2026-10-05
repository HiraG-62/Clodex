import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../agents/agent-adapter.js";
import type { FeedItem } from "../web-feed.js";
import { applyFeedItem, type TimelineItem } from "./timeline.js";

const AT = "2026-10-05T12:00:00.000Z";
let seq = 0;
const agent = (name: "claude" | "codex", event: AgentEvent): FeedItem =>
  ({ type: "event", seq: ++seq, event: { kind: "agent", agent: name, event, at: AT } });
const human = (name: "claude" | "codex", text: string): FeedItem =>
  ({ type: "event", seq: ++seq, event: { kind: "human", agent: name, text, at: AT } });
const output = (text: string): FeedItem => ({ type: "output", seq: ++seq, text });
const run = (items: FeedItem[]) => items.reduce<TimelineItem[]>(applyFeedItem, []);

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
        // 最終応答と同じ最後の発言は作業から外す
        steps: [{ kind: "say", text: "確認します。" }, { kind: "tool", name: "Read", input: "a.ts" }],
      },
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
      { type: "state", state: { project: "C:\app", primary: "claude", roles: {}, agents: [], conversations: [], pendingInputs: [] } },
    ])).toEqual([]);
  });

  it("変更した項目だけ新しいオブジェクトにする（描画の差分に使う）", () => {
    const first = run([human("claude", "x"), agent("claude", { type: "turn_started" })]);
    const next = applyFeedItem(first, agent("claude", { type: "tool", name: "Read", input: "a" }));
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
  });
});
