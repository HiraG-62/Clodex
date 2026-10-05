// Event Bus と Web UI の feed をつなぐ（DESIGN.md §17 Web UI）
import { buildEnvelope } from "../context/context-resolver.js";
import type { EventBus } from "../coordinator/event-bus.js";
import type { WebFeed, WebState } from "./web-feed.js";

// 短い間隔の変化はまとめて送る
const STATE_THROTTLE_MS = 200;

export const connectWebFeed = (bus: EventBus, feed: WebFeed, buildState: () => WebState) => {
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
    feed.publishEvent(event, event.kind === "message" ? buildEnvelope(event.message) : undefined);
    refreshState();
  });
  feed.publishState(buildState());
  return { refreshState };
};
