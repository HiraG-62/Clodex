import type { AgentId } from "../../agents/agent-adapter.js";
import type { NotificationInput } from "../../hub/notify-format.js";
import type { FeedItem } from "../web-feed.js";

export type NotificationCandidate = Omit<NotificationInput, "projectRoot" | "conversationTitle">;

export interface DesktopNotifyState {
  live: boolean;
  working: boolean;
  toolUsed: Partial<Record<AgentId, boolean>>;
  lastTurn?: NotificationCandidate;
}

export function updateDesktopNotify(
  previous: DesktopNotifyState,
  item: FeedItem,
): { state: DesktopNotifyState; notification?: NotificationCandidate } {
  if (item.type === "reset" || item.type === "version") return { state: { live: false, working: false, toolUsed: {} } };
  if (item.type === "state") {
    const working = item.state.agents.some((agent) => agent.status === "busy") || item.state.pendingInputs.length > 0;
    const state: DesktopNotifyState = { ...previous, live: true, working };
    if (!previous.live || !previous.working || working || !previous.lastTurn) return { state };
    return { state: { ...state, lastTurn: undefined }, notification: previous.lastTurn };
  }
  if (item.type !== "event") return { state: previous };
  const event = item.event;
  if (event.kind === "agent" && event.event.type === "turn_started") return { state: { ...previous, working: true, toolUsed: { ...previous.toolUsed, [event.agent]: false } } };
  if (event.kind === "agent" && event.event.type === "tool") return { state: { ...previous, toolUsed: { ...previous.toolUsed, [event.agent]: true } } };
  if (!previous.live) return { state: previous };
  if (event.kind === "question") return { state: previous, notification: { kind: "question", agent: event.agent } };
  if (event.kind === "notice") return event.limitHold
    ? { state: { ...previous, lastTurn: undefined }, notification: { kind: "limitHold", agent: event.limitHold.agent, time: event.limitHold.time } }
    : { state: previous, notification: { kind: "notice", line: event.text } };
  if (event.kind !== "agent") return { state: previous };
  if (event.event.type === "turn") {
    const status = event.event.result.status;
    const kind = status === "completed" ? previous.toolUsed[event.agent] ? "work" : "reply" : status;
    return { state: { ...previous, lastTurn: { kind, agent: event.agent } } };
  }
  if (event.event.type === "error") return { state: previous, notification: { kind: "error", agent: event.agent, line: event.event.message } };
  return { state: previous };
}
