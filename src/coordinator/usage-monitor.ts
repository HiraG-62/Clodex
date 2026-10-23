// Agent ごとの利用状況を集計し、偏りを人に知らせる（DESIGN.md §14 利用枠の可視化と通知）
// 送り先の切り替えは行わない（DESIGN.md §3.6）
import type { AgentId, RateLimitWindow } from "../agents/agent-adapter.js";
import { AGENT_META, peersOf } from "../agents/agent-meta.js";
import { t } from "../i18n/i18n.js";
import type { EventBus } from "./event-bus.js";

export interface UsageAlert {
  weeklyPaceThreshold: number;
  fiveHourThreshold: number;
}

export const DEFAULT_USAGE_ALERT: UsageAlert = { weeklyPaceThreshold: 15, fiveHourThreshold: 90 };

export interface UsageSnapshot {
  fiveHourPercent?: number;
  fiveHourResetsAt?: number; // epoch 秒
  weeklyPercent?: number;
  weeklyPace?: number;
  weeklyResetsAt?: number; // epoch 秒
  contextTokens?: number;
  contextWindow?: number;
  inputTotal?: number;
  contextWarning?: boolean;
}

interface ContextSize {
  tokens: number;
  window?: number;
}

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const PERCENT = 100;
const MS_PER_SECOND = 1000;
const TOKENS_PER_K = 1000;
export type ThreadTokenWarn = number | Partial<Record<AgentId, number>>;

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

// 使用率が 100% 以上でリセット前の枠があれば、そのリセット時刻（epoch 秒。複数なら遅いほう）
export const limitResetAt = (snapshot: UsageSnapshot): number | undefined => {
  const LIMIT_PERCENT = 100;
  const resets = [
    snapshot.fiveHourPercent !== undefined && snapshot.fiveHourPercent >= LIMIT_PERCENT ? snapshot.fiveHourResetsAt : undefined,
    snapshot.weeklyPercent !== undefined && snapshot.weeklyPercent >= LIMIT_PERCENT ? snapshot.weeklyResetsAt : undefined,
  ].filter((value): value is number => value !== undefined);
  return resets.length ? Math.max(...resets) : undefined;
};

export class UsageMonitor {
  private readonly windows = new Map<AgentId, Windows>();
  private readonly contexts = new Map<AgentId, ContextSize>();
  private readonly inputTotals = new Map<AgentId, number>();
  private readonly sessions = new Map<AgentId, string>();
  private readonly warnedSessions = new Set<AgentId>();
  // 同じ枠（reset 時刻）では 1 回だけ通知する
  private readonly notified: Set<string>;

  constructor(
    private readonly bus: EventBus,
    private readonly alert: UsageAlert = DEFAULT_USAGE_ALERT,
    private readonly now: () => Date = () => new Date(),
    private readonly threadTokenWarn?: ThreadTokenWarn,
    notified = new Set<string>(),
  ) {
    this.notified = notified;
    bus.subscribe(event => {
      if (event.kind !== "agent") return;
      const { agent, event: agentEvent } = event;
      // session が変わったら前のコンテキストの大きさは当てはまらない
      if (agentEvent.type === "session" && this.sessions.get(agent) !== agentEvent.sessionId) {
        this.sessions.set(agent, agentEvent.sessionId);
        this.clearContext(agent);
        if (AGENT_META[agent].cumulativeInput) this.inputTotals.set(agent, 0);
      }
      if (agentEvent.type === "compacted") this.contexts.delete(agent);
      if (agentEvent.type === "context") {
        this.contexts.set(agent, { tokens: agentEvent.tokens, ...(agentEvent.window ? { window: agentEvent.window } : {}) });
        if (agentEvent.inputTotal !== undefined) this.inputTotals.set(agent, agentEvent.inputTotal);
        this.checkThreadTokens(agent, agentEvent.tokens);
      }
      if (agentEvent.type === "input_total") this.inputTotals.set(agent, agentEvent.total);
      if (agentEvent.type !== "rate_limit") return;
      const { fiveHour, weekly } = agentEvent;
      const current = this.windows.get(event.agent) ?? {};
      this.windows.set(event.agent, { ...current, ...(fiveHour && { fiveHour }), ...(weekly && { weekly }) });
      this.checkAlerts(event.agent);
    });
  }

  clearContext(agent: AgentId): void {
    this.contexts.delete(agent);
    this.inputTotals.delete(agent);
    this.warnedSessions.delete(agent);
  }

  snapshot(agent: AgentId): UsageSnapshot {
    const nowSeconds = this.nowSeconds();
    // reset 時刻を過ぎた枠は今の利用状況ではないので出さない
    const current = (w: RateLimitWindow | undefined) => (w && w.resetsAt > nowSeconds ? w : undefined);
    const stored = this.windows.get(agent) ?? {};
    const fiveHour = current(stored.fiveHour);
    const weekly = current(stored.weekly);
    return {
      ...(fiveHour && { fiveHourPercent: fiveHour.usedPercent, fiveHourResetsAt: fiveHour.resetsAt }),
      ...(weekly && { weeklyPercent: weekly.usedPercent, weeklyPace: weeklyPace(weekly, nowSeconds), weeklyResetsAt: weekly.resetsAt }),
      ...this.contextOf(agent),
      ...(this.inputTotals.has(agent) ? { inputTotal: this.inputTotals.get(agent)! } : {}),
    };
  }

  private contextOf(agent: AgentId): Pick<UsageSnapshot, "contextTokens" | "contextWindow" | "contextWarning"> {
    const context = this.contexts.get(agent);
    if (!context) return {};
    const threshold = this.tokenThreshold(agent);
    return {
      contextTokens: context.tokens,
      ...(context.window ? { contextWindow: context.window } : {}),
      ...(threshold !== undefined ? { contextWarning: context.tokens > threshold } : {}),
    };
  }

  private tokenThreshold(agent: AgentId): number | undefined {
    return typeof this.threadTokenWarn === "number" ? this.threadTokenWarn : this.threadTokenWarn?.[agent];
  }

  private checkThreadTokens(agent: AgentId, tokens: number): void {
    const threshold = this.tokenThreshold(agent);
    if (threshold === undefined || tokens <= threshold || this.warnedSessions.has(agent)) return;
    this.warnedSessions.add(agent);
    this.bus.publish({ kind: "notice", level: "warn", text: t("notice.threadTokenWarn", { agent, tokens: `${Math.round(threshold / TOKENS_PER_K)}k` }) });
  }

  private nowSeconds(): number {
    return this.now().getTime() / MS_PER_SECOND;
  }

  private checkAlerts(agent: AgentId): void {
    const { fiveHour, weekly } = this.windows.get(agent) ?? {};
    if (weekly) {
      const pace = weeklyPace(weekly, this.nowSeconds());
      if (pace >= this.alert.weeklyPaceThreshold) {
        this.notifyOnce(`${agent}:weekly:${weekly.resetsAt}`, t("notice.weeklyPace", { agent, pace, peer: peersOf(agent).join(", ") }));
      }
    }
    if (fiveHour && fiveHour.usedPercent >= this.alert.fiveHourThreshold) {
      this.notifyOnce(`${agent}:fiveHour:${fiveHour.resetsAt}`, t("notice.fiveHour", { agent, percent: fiveHour.usedPercent }));
    }
  }

  private notifyOnce(key: string, text: string): void {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    this.bus.publish({ kind: "notice", text, level: "warn" });
  }
}
