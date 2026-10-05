import { describe, expect, it } from "vitest";
import type { RateLimitWindow } from "../agents/agent-adapter.js";
import { EventBus } from "./event-bus.js";
import { DEFAULT_USAGE_ALERT, UsageMonitor, weeklyPace } from "./usage-monitor.js";

const DAY_SECONDS = 86_400;
const NOW_SECONDS = 1_800_000_000;
const now = () => new Date(NOW_SECONDS * 1000);

// 週の経過率 elapsed（0〜1）になる reset 時刻
const weeklyResetsAt = (elapsed: number) => NOW_SECONDS + Math.round((1 - elapsed) * 7 * DAY_SECONDS);

const setup = (alert = DEFAULT_USAGE_ALERT) => {
  const bus = new EventBus(now);
  const notices: string[] = [];
  bus.subscribe((e) => {
    if (e.kind === "notice") notices.push(e.text);
  });
  const monitor = new UsageMonitor(bus, alert, now);
  const report = (agent: "claude" | "codex", weekly?: RateLimitWindow, fiveHour?: RateLimitWindow) =>
    bus.publish({ kind: "agent", agent, event: { type: "rate_limit", ...(weekly && { weekly }), ...(fiveHour && { fiveHour }) } });
  return { bus, notices, monitor, report };
};

describe("weeklyPace", () => {
  it("週の使用率 − 週の経過率（ポイント）", () => {
    expect(weeklyPace({ usedPercent: 50, resetsAt: weeklyResetsAt(0.7) }, NOW_SECONDS)).toBe(-20);
    expect(weeklyPace({ usedPercent: 30, resetsAt: weeklyResetsAt(0.2) }, NOW_SECONDS)).toBe(10);
  });

  it("経過率は 0〜1 に収める", () => {
    expect(weeklyPace({ usedPercent: 10, resetsAt: NOW_SECONDS - 100 }, NOW_SECONDS)).toBe(-90);
    expect(weeklyPace({ usedPercent: 10, resetsAt: NOW_SECONDS + 30 * DAY_SECONDS }, NOW_SECONDS)).toBe(10);
  });
});

describe("UsageMonitor", () => {
  it("Agent ごとに最新の利用状況と週のペース超過を保持する", () => {
    const { monitor, report } = setup();
    expect(monitor.snapshot("claude")).toEqual({});
    report("claude", { usedPercent: 50, resetsAt: weeklyResetsAt(0.7) }, { usedPercent: 12, resetsAt: NOW_SECONDS + 3600 });
    expect(monitor.snapshot("claude")).toEqual({ fiveHourPercent: 12, weeklyPercent: 50, weeklyPace: -20 });
    expect(monitor.snapshot("codex")).toEqual({});
  });

  it("reset 時刻を過ぎた枠は表示しない", () => {
    const { monitor, report } = setup();
    report("claude", { usedPercent: 50, resetsAt: NOW_SECONDS - 1 }, { usedPercent: 12, resetsAt: NOW_SECONDS + 3600 });
    expect(monitor.snapshot("claude")).toEqual({ fiveHourPercent: 12 });
  });

  it("片方の枠だけの更新でも、もう片方の値を保持する", () => {
    const { monitor, report } = setup();
    report("codex", { usedPercent: 30, resetsAt: weeklyResetsAt(0.5) }, { usedPercent: 5, resetsAt: NOW_SECONDS + 3600 });
    report("codex", undefined, { usedPercent: 6, resetsAt: NOW_SECONDS + 3600 });
    expect(monitor.snapshot("codex")).toEqual({ fiveHourPercent: 6, weeklyPercent: 30, weeklyPace: -20 });
  });

  it("週のペース超過が閾値以上になったら、相手 Agent への切り替えを促す通知を 1 回だけ出す", () => {
    const { notices, report } = setup();
    report("claude", { usedPercent: 40, resetsAt: weeklyResetsAt(0.2) });
    report("claude", { usedPercent: 41, resetsAt: weeklyResetsAt(0.2) });
    expect(notices).toEqual(["claude is ahead of weekly pace (+20). Consider /primary codex for the next task."]);
  });

  it("5 時間枠が閾値以上になったら 1 回だけ通知する", () => {
    const { notices, report } = setup();
    report("codex", undefined, { usedPercent: 91, resetsAt: NOW_SECONDS + 3600 });
    report("codex", undefined, { usedPercent: 95, resetsAt: NOW_SECONDS + 3600 });
    expect(notices).toEqual(["codex 5h usage is 91%."]);
  });

  it("枠が reset されたら再び通知できる", () => {
    const { notices, report } = setup();
    report("codex", undefined, { usedPercent: 91, resetsAt: NOW_SECONDS + 3600 });
    report("codex", undefined, { usedPercent: 92, resetsAt: NOW_SECONDS + 3600 + 5 * 3600 });
    expect(notices).toHaveLength(2);
  });

  it("閾値は設定で変えられる", () => {
    const { notices, report } = setup({ weeklyPaceThreshold: 30, fiveHourThreshold: 99 });
    report("claude", { usedPercent: 40, resetsAt: weeklyResetsAt(0.2) }, { usedPercent: 95, resetsAt: NOW_SECONDS + 3600 });
    expect(notices).toEqual([]);
  });

  it("context event でコンテキストの大きさを保持し、session が変わったら unknown に戻す", () => {
    const { monitor, bus } = setup();
    bus.publish({ kind: "agent", agent: "claude", event: { type: "context", tokens: 85000, window: 200000 } });
    expect(monitor.snapshot("claude")).toEqual({ contextTokens: 85000, contextWindow: 200000 });
    bus.publish({ kind: "agent", agent: "claude", event: { type: "session", sessionId: "new" } });
    expect(monitor.snapshot("claude")).toEqual({});
  });

  it("clearContext でコンテキストの大きさを unknown に戻す", () => {
    const { monitor, bus } = setup();
    bus.publish({ kind: "agent", agent: "codex", event: { type: "context", tokens: 1000 } });
    monitor.clearContext("codex");
    expect(monitor.snapshot("codex")).toEqual({});
  });

  it("rate_limit 以外の event は無視する", () => {
    const { monitor, bus } = setup();
    bus.publish({ kind: "agent", agent: "claude", event: { type: "text", text: "x" } });
    expect(monitor.snapshot("claude")).toEqual({});
  });
});
