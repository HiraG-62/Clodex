// feed からログの項目を組み立てる（DESIGN.md §17 Web UI）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない 1 つの関数として書く（型の import のみ）
import type { AgentId, AgentStatus, TurnResult } from "../../agents/agent-adapter.js";
import type { UserQuestion } from "../../protocol/questions.js";
import type { AgentMessage } from "../../protocol/messages.js";
import type { FeedItem, HistoryItem } from "../web-feed.js";

export type TimelineStep = { kind: "say"; text: string } | { kind: "tool"; name: string; input: string; files?: string[] };

export type TimelineItem =
  | { kind: "question"; id: string; at: string; agent: AgentId; questions: UserQuestion[]; answers?: string[][] }
  | { kind: "human"; id: string; at: string; agent: AgentId; text: string; steer?: boolean; queued?: boolean }
  | {
    kind: "turn"; id: string; at: string; agent: AgentId;
    status: "working" | TurnResult["status"]; steps: TimelineStep[]; text: string;
    plan?: string; // ターンの最初の発言（方針。DESIGN.md §17 ログ）
  }
  | { kind: "message"; id: string; at: string; message: AgentMessage; envelope?: string }
  | { kind: "notice"; id: string; at: string; text: string }
  | { kind: "error"; id: string; at: string; agent: AgentId; text: string }
  | { kind: "output"; id: string; text: string };

export type DisplayTimelineItem = TimelineItem | { kind: "starting"; id: string; at: string; agent: AgentId };

export function withStartingTurns(items: readonly TimelineItem[], agents: readonly { id: AgentId; status: AgentStatus }[], now: string, pendingInputs: readonly { agent: AgentId }[] = []): DisplayTimelineItem[] {
  const result: DisplayTimelineItem[] = [...items];
  for (const agent of agents) {
    if (agent.status === "stopped") continue;
    const last = items.findLast((item) => "agent" in item && item.agent === agent.id && ["human", "turn", "error"].includes(item.kind));
    if (agent.status === "busy" || pendingInputs.some((input) => input.agent === agent.id)) {
      if (last?.kind === "human" && !last.queued && !last.steer) result[result.indexOf(last)] = { ...last, queued: true };
      continue;
    }
    if (last?.kind === "turn" && last.status === "working") continue;
    const waiting = last?.kind === "human" && !last.steer && !last.queued;
    if (agent.status !== "starting" && !waiting) continue;
    result.push({ kind: "starting", id: `starting-${agent.id}`, at: last && "at" in last ? last.at : now, agent: agent.id });
  }
  return result;
}

// 変更した項目だけを新しいオブジェクトにして返す（画面は項目の同一性で差分を描画する）
export function applyFeedItem(items: TimelineItem[], item: FeedItem): TimelineItem[] {
  const MAX_ITEMS = 1500;
  const limit = (list: TimelineItem[]) => (list.length > MAX_ITEMS ? list.slice(list.length - MAX_ITEMS) : list);
  type Turn = Extract<TimelineItem, { kind: "turn" }>;

  if (item.type === "state" || item.type === "version" || item.type === "toast") return items;
  if (item.type === "reset") return [];
  if (item.type === "output") {
    const last = items[items.length - 1];
    if (last?.kind === "output") return [...items.slice(0, -1), { ...last, text: `${last.text}\n${item.text}` }];
    return limit([...items, { kind: "output", id: `o${item.seq}`, text: item.text }]);
  }

  const id = `e${item.seq}`;
  const { event } = item;
  if (event.kind === "question") return limit([...items, { kind: "question", id: event.id, agent: event.agent, at: event.at, questions: event.questions }]);
  if (event.kind === "answer") return items.map((entry) => entry.kind === "question" && entry.id === event.id ? { ...entry, answers: event.answers } : entry);
  if (event.kind === "human") {
    return limit([...items, { kind: "human", id, at: event.at, agent: event.agent, text: event.text, ...(event.steer ? { steer: true } : {}) }]);
  }
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
      return updateTurn((turn) => ({ ...turn, steps: [...turn.steps, { kind: "tool", name: agentEvent.name, input: agentEvent.input, ...(agentEvent.files ? { files: agentEvent.files } : {}) }] }));
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

export function rebuildTimeline(history: readonly HistoryItem[], apply: typeof applyFeedItem): TimelineItem[] {
  return history.reduce<TimelineItem[]>(apply, []);
}
