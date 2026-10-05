// Event Bus と Web UI の feed をつなぐ（DESIGN.md §17 Web UI）
import { buildEnvelope } from "../context/context-resolver.js";
import type { Language } from "../context/language.js";
import type { AgentEvent } from "../agents/agent-adapter.js";
import type { CoordinatorEvent } from "../coordinator/event-bus.js";
import type { HistoryItem, WebFeed, WebState } from "./web-feed.js";

// 短い間隔の変化はまとめて送る
const STATE_THROTTLE_MS = 200;
const FEED_AGENT_EVENTS: ReadonlySet<AgentEvent["type"]> = new Set(["turn_started", "text", "tool", "turn", "error", "compacted"]);
// 保存した feed を読み込むときに通し番号を振り直すので、保存時の番号は使わない
const UNNUMBERED = 0;

// 今の会話の event を流す元（Event Bus。会話ごとに Coordinator がある場合は今の会話の event だけを渡す）
export interface EventSource {
  subscribe(listener: (event: CoordinatorEvent) => void): unknown;
}

const isFeedEvent = (event: CoordinatorEvent) => event.kind !== "agent" || FEED_AGENT_EVENTS.has(event.event.type);
const envelopeOf = (event: CoordinatorEvent, language?: Language) =>
  (event.kind === "message" ? buildEnvelope(event.message, language) : undefined);

// 今の会話でない会話の event を、その会話の feed に保存する形にする（DESIGN.md §28 D1）。流さない event なら undefined
export const historyItemOf = (event: CoordinatorEvent, language?: Language): HistoryItem | undefined => {
  if (!isFeedEvent(event)) return undefined;
  const envelope = envelopeOf(event, language);
  return { type: "event", seq: UNNUMBERED, event, ...(envelope ? { envelope } : {}) };
};

export const connectWebFeed = (source: EventSource, feed: WebFeed, buildState: () => WebState, language?: Language) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshState = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      feed.publishState(buildState());
    }, STATE_THROTTLE_MS);
    timer.unref?.();
  };

  source.subscribe((event) => {
    if (isFeedEvent(event)) feed.publishEvent(event, envelopeOf(event, language));
    refreshState();
  });
  feed.publishState(buildState());
  return { refreshState };
};
