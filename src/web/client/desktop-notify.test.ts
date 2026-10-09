import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../agents/agent-adapter.js";
import type { FeedItem, WebState } from "../web-feed.js";
import { type DesktopNotifyState, updateDesktopNotify } from "./desktop-notify.js";

const IDLE: WebState = {
  project: "app",
  primary: "claude",
  roles: {},
  agents: [],
  tabs: [],
  conversations: [],
  pendingInputs: [],
  pendingMessages: [],
  questions: [],
  processes: [],
  language: "ja",
  sandbox: { enabled: false, ready: false },
  limitsUnlimited: false,
  limits: { messages: { value: 8, default: 8 }, reviews: { value: 3, default: 3 }, delegations: { value: 4, default: 4 }, depth: { value: 2, default: 2 } },
};
const state = (pending = false): FeedItem => ({ type: "state", state: { ...IDLE, pendingInputs: pending ? [{ id: "1", agent: "claude", text: "次" }] : [] } });
const event = (value: AgentEvent, agent: "claude" | "codex" = "claude"): FeedItem => ({
  type: "event",
  seq: 1,
  event: { kind: "agent", agent, event: value, at: "now" },
});
const turn = (status: "completed" | "failed" | "interrupted" = "completed", agent: "claude" | "codex" = "claude") =>
  event({ type: "turn", result: { status, text: "本文" } }, agent);

const session = () => {
  let current: DesktopNotifyState = { live: false, working: false, toolUsed: {} };
  return (item: FeedItem) => {
    const result = updateDesktopNotify(current, item);
    current = result.state;
    return result.notification;
  };
};

describe("updateDesktopNotify", () => {
  it("tool の無いターンは全員が止まってから 1 回だけ応答通知にする", () => {
    const next = session();
    next(state());
    next(event({ type: "turn_started" }));
    next(turn());
    expect(next(state())).toEqual({ kind: "reply", agent: "claude" });
    expect(next(state())).toBeUndefined();
  });

  it("最後に終わったターンが Agent 間の途中なら通知しない", () => {
    const next = session();
    next(state());
    next(event({ type: "turn_started" }));
    const handoff: FeedItem = {
      type: "event",
      seq: 2,
      event: { kind: "agent", agent: "claude", event: { type: "turn", result: { status: "completed", text: "途中" } }, at: "now", handoff: true },
    };
    next(handoff);
    expect(next(state())).toBeUndefined();
    next(event({ type: "turn_started" }));
    next(turn());
    expect(next(state())).toEqual({ kind: "reply", agent: "claude" });
  });

  it("tool を使ったターンは作業完了にし、配送待ちと他 Agent の作業中は待つ", () => {
    const next = session();
    next(state());
    next(state(true));
    next(event({ type: "turn_started" }));
    next(event({ type: "tool", name: "Read", input: "a.ts" }));
    next(turn());
    expect(next(state(true))).toBeUndefined();
    next(turn("completed", "codex"));
    expect(next(state())).toEqual({ kind: "reply", agent: "codex" });
  });

  it("tool の有無、失敗・中断、質問、エラー、上限を判定する", () => {
    const next = session();
    next(state());
    next(event({ type: "turn_started" }));
    next(event({ type: "tool", name: "Read", input: "a.ts" }));
    next(turn());
    expect(next(state())).toEqual({ kind: "work", agent: "claude" });
    for (const kind of ["failed", "interrupted"] as const) {
      next(event({ type: "turn_started" }));
      next(turn(kind));
      expect(next(state())).toEqual({ kind, agent: "claude" });
    }
    expect(next({ type: "event", seq: 2, event: { kind: "question", id: "q", agent: "codex", questions: [], at: "now" } })).toEqual({
      kind: "question",
      agent: "codex",
    });
    expect(next(event({ type: "error", message: "失敗" }))).toEqual({ kind: "error", agent: "claude", line: "失敗" });
    expect(next({ type: "event", seq: 3, event: { kind: "notice", text: "上限", limitHold: { agent: "claude", time: "01:00" }, at: "now" } })).toEqual({
      kind: "limitHold",
      agent: "claude",
      time: "01:00",
    });
  });

  it("上限の notice が来たら直前の失敗を重ねて通知しない", () => {
    const next = session();
    next(state());
    next(event({ type: "turn_started" }));
    next(turn("failed"));
    expect(next({ type: "event", seq: 4, event: { kind: "notice", text: "上限", limitHold: { agent: "claude", time: "01:00" }, at: "now" } })).toEqual({
      kind: "limitHold",
      agent: "claude",
      time: "01:00",
    });
    expect(next(state())).toBeUndefined();
  });

  it("初回と履歴の再生では通知しない", () => {
    const next = session();
    expect(next(event({ type: "error", message: "履歴" }))).toBeUndefined();
    next({ type: "reset" });
    expect(next(event({ type: "error", message: "履歴" }))).toBeUndefined();
    next(state());
    expect(next(event({ type: "error", message: "新規" }))).toEqual({ kind: "error", agent: "claude", line: "新規" });
  });

  it("再生中の tool は覚え、再接続後に完了したターンを作業完了と判定する", () => {
    const next = session();
    next({ type: "reset" });
    next(event({ type: "turn_started" }));
    next(event({ type: "tool", name: "Read", input: "a.ts" }));
    expect(next(state(true))).toBeUndefined();
    next(turn());
    expect(next(state())).toEqual({ kind: "work", agent: "claude" });
  });
});
