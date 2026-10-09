import type { AgentEvent, RateLimitWindow } from "./agent-adapter.js";

export interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

const FIVE_HOUR_WINDOW_MINS = 300;
const WEEKLY_WINDOW_MINS = 10080;
const toWindow = (window: CodexRateLimitWindow | null | undefined): RateLimitWindow | undefined =>
  window?.usedPercent === undefined || window.resetsAt === undefined ? undefined : { usedPercent: window.usedPercent, resetsAt: window.resetsAt };

export const codexRateLimitEvent = (limits: CodexRateLimits | undefined): Extract<AgentEvent, { type: "rate_limit" }> => {
  const windows = [limits?.primary, limits?.secondary];
  const byDuration = (minutes: number) => toWindow(windows.find(window => window?.windowDurationMins === minutes));
  const fiveHour = byDuration(FIVE_HOUR_WINDOW_MINS);
  const weekly = byDuration(WEEKLY_WINDOW_MINS);
  return { type: "rate_limit", ...(fiveHour && { fiveHour }), ...(weekly && { weekly }) };
};
