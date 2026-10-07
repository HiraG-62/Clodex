import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../agents/agent-adapter.js";
import { en, ja } from "../../i18n/messages.js";
import type { FeedItem, WebState } from "../web-feed.js";
import { updateDesktopNotify, type DesktopNotifyState } from "./desktop-notify.js";

const IDLE: WebState = { project: "app", primary: "claude", roles: {}, agents: [], conversations: [], pendingInputs: [], questions: [], processes: [], language: "ja", sandbox: { enabled: false, ready: false }, limitsUnlimited: false, limits: { messages: { value: 8, default: 8 }, reviews: { value: 3, default: 3 }, delegations: { value: 4, default: 4 }, depth: { value: 2, default: 2 } } };
const state = (pending = false): FeedItem => ({ type: "state", state: { ...IDLE, pendingInputs: pending ? [{ id: "1", agent: "claude", text: "次" }] : [] } });
const event = (value: AgentEvent, agent: "claude" | "codex" = "claude"): FeedItem => ({ type: "event", seq: 1, event: { kind: "agent", agent, event: value, at: "now" } });
const turn = (text = "完了\n詳細", status: "completed" | "failed" | "interrupted" = "completed") => event({ type: "turn", result: { status, text } });
const notice: FeedItem = { type: "event", seq: 2, event: { kind: "notice", text: "利用枠", at: "now" } };

describe("desktop-notify", () => {
  const session = () => {
    let current: DesktopNotifyState = { live: false, working: false };
    return (item: FeedItem) => {
      const result = updateDesktopNotify(current, item, ja);
      current = result.state;
      return result.notification;
    };
  };

  it("短いターンも state の集約で失わず、作業終了で一度だけ通知", () => {
    const next = session();
    next(state());
    expect(next(event({ type: "turn_started" }))).toBeUndefined();
    expect(next(turn())).toBeUndefined();
    expect(next(state())).toEqual({ title: "Clodex · 作業終了", body: "Claude: 完了" });
    expect(next(state())).toBeUndefined();
  });

  it("配送待ちの間は通知せず最後に終了した Agent の応答を使用", () => {
    const next = session();
    next(state());
    next(state(true));
    next(turn());
    expect(next(state(true))).toBeUndefined();
    next(event({ type: "turn", result: { status: "completed", text: "最後" } }, "codex"));
    expect(next(state())?.body).toBe("Codex: 最後");
  });

  it("初回 state が busy なら終了を通知し、他の Agent が busy の間は待つ", () => {
    const next = session();
    const busy: FeedItem = { type: "state", state: { ...IDLE, agents: [{ id: "codex", status: "busy", sessionId: undefined, permission: "edit", models: [], usage: {} }] } };
    expect(next(busy)).toBeUndefined();
    next(turn());
    expect(next(busy)).toBeUndefined();
    next(event({ type: "turn", result: { status: "completed", text: "終了" } }, "codex"));
    expect(next(state())?.body).toBe("Codex: 終了");
  });

  it("初回・reset・再接続の再生では通知しない", () => {
    const next = session();
    for (const boundary of [{ type: "reset" }, { type: "version", version: "v" }] as const) {
      next(boundary);
      expect(next(notice)).toBeUndefined();
      next(event({ type: "turn_started" }));
      next(turn());
      expect(next(state())).toBeUndefined();
    }
    expect(next(notice)?.body).toBe("利用枠");
  });

  it("live の notice と error を通知", () => {
    const next = session();
    next(state());
    expect(next(notice)).toEqual({ title: "Clodex · 通知", body: "利用枠" });
    expect(next(event({ type: "error", message: "失敗" }))).toEqual({ title: "Clodex · エラー", body: "Claude: 失敗" });
  });

  it.each(["failed", "interrupted"] as const)("%s は応答本文ではなく状態を通知", (status) => {
    const next = session();
    next(state());
    next(event({ type: "turn_started" }));
    next(turn("本文", status));
    expect(next(state())?.body).toBe(`Claude: ${ja[status === "failed" ? "web.turn.failed" : "web.turn.interrupted"]}`);
  });

  it("1 行目を最大 160 文字に省略し英語カタログも利用", () => {
    const current: DesktopNotifyState = { live: true, working: true, lastTurn: { agent: "codex", result: { status: "completed", text: `${"a".repeat(200)}\n後` } } };
    expect(updateDesktopNotify(current, state(), en).notification).toEqual({ title: "Clodex · Work finished", body: `Codex: ${"a".repeat(159)}…` });
  });
});

it("toast をデスクトップ通知にする", () => {
  const result = updateDesktopNotify({ live: true, working: false }, { type: "toast", text: "切り替え", level: "info" }, ja);
  expect(result.notification).toEqual({ title: "Clodex · 通知", body: "切り替え" });
});

it("新しい質問を通知し、履歴の再生時には通知しない", () => {
  const item: FeedItem = { type: "event", seq: 1, event: { kind: "question", id: "q1", agent: "claude", at: "now", questions: [{ question: "方針は", options: [{ label: "A" }, { label: "B" }] }] } };
  expect(updateDesktopNotify({ live: true, working: true }, item, ja).notification).toEqual({ title: "質問", body: "方針は" });
  expect(updateDesktopNotify({ live: false, working: false }, item, ja).notification).toBeUndefined();
});
