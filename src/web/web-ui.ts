// Event Bus と Web UI の feed をつなぐ（DESIGN.md §17 Web UI）
import { buildEnvelope } from "../context/context-resolver.js";
import type { Language } from "../context/language.js";
import type { AgentEvent } from "../agents/agent-adapter.js";
import type { EventBus } from "../coordinator/event-bus.js";
import type { WebFeed, WebState } from "./web-feed.js";

// 短い間隔の変化はまとめて送る
const STATE_THROTTLE_MS = 200;
const FEED_AGENT_EVENTS: ReadonlySet<AgentEvent["type"]> = new Set(["turn_started", "text", "tool", "turn", "error", "compacted"]);

export const connectWebFeed = (bus: EventBus, feed: WebFeed, buildState: () => WebState, language?: Language) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshState = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      feed.publishState(buildState());
    }, STATE_THROTTLE_MS);
    timer.unref?.();
  };

  bus.subscribe((event) => {
    if (event.kind !== "agent" || FEED_AGENT_EVENTS.has(event.event.type)) {
      feed.publishEvent(event, event.kind === "message" ? buildEnvelope(event.message, language) : undefined);
    }
    refreshState();
  });
  feed.publishState(buildState());
  return { refreshState };
};
