// feed からログの項目を組み立てる（DESIGN.md §17 Web UI）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない 1 つの関数として書く（型の import のみ）
import type { AgentId, TurnResult } from "../../agents/agent-adapter.js";
import type { AgentMessage } from "../../protocol/messages.js";
import type { FeedItem } from "../web-feed.js";

export type TimelineStep = { kind: "say"; text: string } | { kind: "tool"; name: string; input: string };

export type TimelineItem =
  | { kind: "human"; id: string; at: string; agent: AgentId; text: string }
  | {
    kind: "turn"; id: string; at: string; agent: AgentId;
    status: "working" | TurnResult["status"]; steps: TimelineStep[]; text: string;
    plan?: string; // ターンの最初の発言（方針。DESIGN.md §17 ログ）
  }
  | { kind: "message"; id: string; at: string; message: AgentMessage; envelope?: string }
  | { kind: "notice"; id: string; at: string; text: string }
  | { kind: "error"; id: string; at: string; agent: AgentId; text: string }
  | { kind: "output"; id: string; text: string };

// 変更した項目だけを新しいオブジェクトにして返す（画面は項目の同一性で差分を描画する）
export function applyFeedItem(items: TimelineItem[], item: FeedItem): TimelineItem[] {
  const MAX_ITEMS = 1500;
  const limit = (list: TimelineItem[]) => (list.length > MAX_ITEMS ? list.slice(list.length - MAX_ITEMS) : list);
  type Turn = Extract<TimelineItem, { kind: "turn" }>;

  if (item.type === "state") return items;
  if (item.type === "reset") return [];
  if (item.type === "output") {
    const last = items[items.length - 1];
    if (last?.kind === "output") return [...items.slice(0, -1), { ...last, text: `${last.text}\n${item.text}` }];
    return limit([...items, { kind: "output", id: `o${item.seq}`, text: item.text }]);
  }

  const id = `e${item.seq}`;
  const { event } = item;
  if (event.kind === "human") return limit([...items, { kind: "human", id, at: event.at, agent: event.agent, text: event.text }]);
  if (event.kind === "notice") return limit([...items, { kind: "notice", id, at: event.at, text: event.text }]);
  if (event.kind === "message") {
    return limit([...items, { kind: "message", id, at: event.at, message: event.message, ...(item.envelope ? { envelope: item.envelope } : {}) }]);
  }

  const { agent, event: agentEvent, at } = event;
  const newTurn = (): Turn => ({ kind: "turn", id, at, agent, status: "working", steps: [], text: "" });
  // その Agent の実行中のターンを更新する。開始を受け取っていなければ新しいターンとして受け止める
  const updateTurn = (update: (turn: Turn) => Turn): TimelineItem[] => {
    for (let i = items.length - 1; i >= 0; i--) {
      const candidate = items[i];
      if (candidate?.kind === "turn" && candidate.agent === agent && candidate.status === "working") {
        return [...items.slice(0, i), update(candidate), ...items.slice(i + 1)];
      }
    }
    return limit([...items, update(newTurn())]);
  };

  switch (agentEvent.type) {
    case "turn_started":
      return limit([...items, newTurn()]);
    case "text":
      return updateTurn((turn) => (turn.plan === undefined
        ? { ...turn, plan: agentEvent.text }
        : { ...turn, steps: [...turn.steps, { kind: "say", text: agentEvent.text }] }));
    case "tool":
      return updateTurn((turn) => ({ ...turn, steps: [...turn.steps, { kind: "tool", name: agentEvent.name, input: agentEvent.input }] }));
    case "turn":
      return updateTurn((turn) => {
        const { status, text } = agentEvent.result;
        const last = turn.steps[turn.steps.length - 1];
        // 最終応答は本文として出すので、同じ内容の最後の発言は作業から外す
        const steps = last?.kind === "say" && last.text.trim() === text.trim() ? turn.steps.slice(0, -1) : turn.steps;
        // 発言が最終応答だけなら、方針として重ねて出さない
        if (turn.plan !== undefined && turn.plan.trim() === text.trim()) {
          const { plan: _same, ...rest } = turn;
          return { ...rest, status, text, steps };
        }
        return { ...turn, status, text, steps };
      });
    case "error":
      return limit([...items, { kind: "error", id, at, agent, text: agentEvent.message }]);
    case "compacted":
      return limit([...items, { kind: "notice", id, at, text: `${agent}: compacted` }]);
    default:
      return items;
  }
}
