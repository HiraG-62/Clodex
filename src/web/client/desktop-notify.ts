import type { AgentId, TurnResult } from "../../agents/agent-adapter.js";
import type { Messages } from "../../i18n/messages.js";
import type { FeedItem } from "../web-feed.js";

export interface DesktopNotification {
  title: string;
  body: string;
}

export interface DesktopNotifyState {
  live: boolean;
  working: boolean;
  lastTurn?: { agent: AgentId; result: TurnResult };
}

export function updateDesktopNotify(
  previous: DesktopNotifyState,
  item: FeedItem,
  messages: Messages,
): { state: DesktopNotifyState; notification?: DesktopNotification } {
  const MAX_LINE_LENGTH = 160;
  const names = { claude: "Claude", codex: "Codex" };
  const firstLine = (text: string) => {
    const line = Array.from(text.split(/\r?\n/, 1)[0] ?? "");
    return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1).join("")}…` : line.join("");
  };
  if (item.type === "reset" || item.type === "version") return { state: { live: false, working: false } };
  if (item.type === "state") {
    const working = item.state.agents.some((agent) => agent.status === "busy") || item.state.pendingInputs.length > 0;
    const state: DesktopNotifyState = { ...previous, live: true, working };
    if (!previous.live || !previous.working || working || !previous.lastTurn) return { state };
    const { agent, result } = previous.lastTurn;
    const text = result.status === "failed" ? messages["web.turn.failed"]
      : result.status === "interrupted" ? messages["web.turn.interrupted"]
        : firstLine(result.text) || messages["web.turn.completed"];
    return { state: { live: true, working: false }, notification: { title: messages["desktop.notify.finished"], body: `${names[agent]}: ${text}` } };
  }
  if (!previous.live || item.type !== "event") return { state: previous };
  const event = item.event;
  if (event.kind === "notice") return { state: previous, notification: { title: messages["desktop.notify.notice"], body: event.text } };
  if (event.kind !== "agent") return { state: previous };
  if (event.event.type === "turn_started") return { state: { ...previous, working: true } };
  if (event.event.type === "turn") return { state: { ...previous, lastTurn: { agent: event.agent, result: event.event.result } } };
  if (event.event.type === "error") return { state: previous, notification: { title: messages["desktop.notify.error"], body: `${names[event.agent]}: ${event.event.message}` } };
  return { state: previous };
}
