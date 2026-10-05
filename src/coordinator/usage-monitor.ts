// Agent ごとの利用状況を集計し、偏りを人に知らせる（DESIGN.md §14 利用枠の可視化と通知）
// 送り先の切り替えは行わない（DESIGN.md §3.6）
import { AGENT_IDS, type AgentId, type RateLimitWindow } from "../agents/agent-adapter.js";
import type { EventBus } from "./event-bus.js";

export interface UsageAlert {
  weeklyPaceThreshold: number;
  fiveHourThreshold: number;
}

export const DEFAULT_USAGE_ALERT: UsageAlert = { weeklyPaceThreshold: 15, fiveHourThreshold: 90 };

export interface UsageSnapshot {
  fiveHourPercent?: number;
  weeklyPercent?: number;
  weeklyPace?: number;
  contextTokens?: number;
  contextWindow?: number;
}

interface ContextSize {
  tokens: number;
  window?: number;
}

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const PERCENT = 100;
const MS_PER_SECOND = 1000;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// 週の使用率 − 週の経過率（ポイント）。正なら使いすぎ、負なら余裕あり
export const weeklyPace = (weekly: RateLimitWindow, nowSeconds: number): number => {
  const elapsed = clamp01(1 - (weekly.resetsAt - nowSeconds) / WEEK_SECONDS);
  return Math.round(weekly.usedPercent - elapsed * PERCENT);
};

interface Windows {
  fiveHour?: RateLimitWindow;
  weekly?: RateLimitWindow;
}

const peerOf = (agent: AgentId): AgentId => AGENT_IDS.find((id) => id !== agent)!;

export class UsageMonitor {
  private readonly windows = new Map<AgentId, Windows>();
  private readonly contexts = new Map<AgentId, ContextSize>();
  // 同じ枠（reset 時刻）では 1 回だけ通知する
  private readonly notified = new Set<string>();

  constructor(
    private readonly bus: EventBus,
    private readonly alert: UsageAlert = DEFAULT_USAGE_ALERT,
    private readonly now: () => Date = () => new Date(),
  ) {
    bus.subscribe((event) => {
      if (event.kind !== "agent") return;
      const { agent, event: agentEvent } = event;
      // session が変わったら前のコンテキストの大きさは当てはまらない
      if (agentEvent.type === "session" || agentEvent.type === "compacted") this.contexts.delete(agent);
      if (agentEvent.type === "context") {
        this.contexts.set(agent, { tokens: agentEvent.tokens, ...(agentEvent.window ? { window: agentEvent.window } : {}) });
      }
      if (agentEvent.type !== "rate_limit") return;
      const { fiveHour, weekly } = agentEvent;
      const current = this.windows.get(event.agent) ?? {};
      this.windows.set(event.agent, { ...current, ...(fiveHour && { fiveHour }), ...(weekly && { weekly }) });
      this.checkAlerts(event.agent);
    });
  }

  clearContext(agent: AgentId): void {
    this.contexts.delete(agent);
  }

  snapshot(agent: AgentId): UsageSnapshot {
    const nowSeconds = this.nowSeconds();
    // reset 時刻を過ぎた枠は今の利用状況ではないので出さない
    const current = (w: RateLimitWindow | undefined) => (w && w.resetsAt > nowSeconds ? w : undefined);
    const stored = this.windows.get(agent) ?? {};
    const fiveHour = current(stored.fiveHour);
    const weekly = current(stored.weekly);
    return {
      ...(fiveHour && { fiveHourPercent: fiveHour.usedPercent }),
      ...(weekly && { weeklyPercent: weekly.usedPercent, weeklyPace: weeklyPace(weekly, nowSeconds) }),
      ...this.contextOf(agent),
    };
  }

  private contextOf(agent: AgentId): Pick<UsageSnapshot, "contextTokens" | "contextWindow"> {
    const context = this.contexts.get(agent);
    if (!context) return {};
    return { contextTokens: context.tokens, ...(context.window ? { contextWindow: context.window } : {}) };
  }

  private nowSeconds(): number {
    return this.now().getTime() / MS_PER_SECOND;
  }

  private checkAlerts(agent: AgentId): void {
    const { fiveHour, weekly } = this.windows.get(agent) ?? {};
    if (weekly) {
      const pace = weeklyPace(weekly, this.nowSeconds());
      if (pace >= this.alert.weeklyPaceThreshold) {
        this.notifyOnce(`${agent}:weekly:${weekly.resetsAt}`,
          `${agent} is ahead of weekly pace (+${pace}). Consider /primary ${peerOf(agent)} for the next task.`);
      }
    }
    if (fiveHour && fiveHour.usedPercent >= this.alert.fiveHourThreshold) {
      this.notifyOnce(`${agent}:fiveHour:${fiveHour.resetsAt}`, `${agent} 5h usage is ${fiveHour.usedPercent}%.`);
    }
  }

  private notifyOnce(key: string, text: string): void {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    this.bus.publish({ kind: "notice", text });
  }
}
