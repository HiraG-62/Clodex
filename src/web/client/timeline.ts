// feed からログの項目を組み立てる（DESIGN.md §17 Web UI）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない 1 つの関数として書く（型の import のみ）
import type { AgentId, AgentStatus, SubagentState, TurnResult } from "../../agents/agent-adapter.js";
import type { UserQuestion } from "../../protocol/questions.js";
import type { AgentMessage } from "../../protocol/messages.js";
import type { FeedItem, HistoryItem } from "../web-feed.js";

export type TimelineStep = { kind: "say"; text: string; at: string } | { kind: "tool"; name: string; input: string; files?: string[] };

export type TimelineItem =
  | { kind: "question"; id: string; at: string; agent: AgentId; questions: UserQuestion[]; answers?: string[][] }
  | { kind: "human"; id: string; at: string; agent: AgentId; text: string; steer?: boolean; steerId?: string; delivered?: boolean; queued?: boolean }
  | {
    kind: "turn"; id: string; at: string; agent: AgentId;
    status: "working" | TurnResult["status"]; steps: TimelineStep[]; text: string;
    plan?: string; // ターンの最初の発言（方針。DESIGN.md §17 ログ）
    planAt?: string;
    resultId?: string; // 最終応答を後ろの別の項目に出した枠の、その項目
    processId?: string; // 最終応答だけの項目の、方針と作業を残した枠
  }
  | { kind: "message"; id: string; at: string; message: AgentMessage; envelope?: string }
  | { kind: "notice"; id: string; at: string; text: string }
  | { kind: "error"; id: string; at: string; agent: AgentId; text: string }
  | { kind: "output"; id: string; text: string };

export type DisplayTimelineItem = TimelineItem
  | { kind: "starting"; id: string; at: string; agent: AgentId }
  | { kind: "subagents"; id: string; agent: AgentId; running: SubagentState[] };

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

export function withSubagentRows(items: readonly DisplayTimelineItem[], agents: readonly { id: AgentId; status: AgentStatus; subagents: readonly SubagentState[] }[]): DisplayTimelineItem[] {
  const result = [...items];
  for (const agent of agents) {
    if (agent.status === "busy" || agent.status === "starting" || !agent.subagents.length) continue;
    if (items.some((item) => item.kind === "starting" && item.agent === agent.id)) continue;
    result.push({ kind: "subagents", id: `subagents-${agent.id}`, agent: agent.id, running: [...agent.subagents] });
  }
  return result;
}

// 変更した項目だけを新しいオブジェクトにして返す（画面は項目の同一性で差分を描画する）
export function applyFeedItem(items: TimelineItem[], item: FeedItem): TimelineItem[] {
  const MAX_ITEMS = 1500;
  const limit = (list: TimelineItem[]) => (list.length > MAX_ITEMS ? list.slice(list.length - MAX_ITEMS) : list);
  type Turn = Extract<TimelineItem, { kind: "turn" }>;

  if (item.type === "state" || item.type === "version" || item.type === "toast" || item.type === "gui" || item.type === "gui_command") return items;
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
    return limit([...items, { kind: "human", id, at: event.at, agent: event.agent, text: event.text,
      ...(event.steer ? { steer: true } : {}), ...(event.steerId ? { steerId: event.steerId } : {}) }]);
  }
  if (event.kind === "notice") return limit([...items, { kind: "notice", id, at: event.at, text: event.text }]);
  if (event.kind === "message") {
    return limit([...items, { kind: "message", id, at: event.at, message: event.message, ...(item.envelope ? { envelope: item.envelope } : {}) }]);
  }

  const { agent, event: agentEvent, at } = event;
  if (agentEvent.type === "steer_delivered") {
    return items.map((entry) => entry.kind === "human" && entry.steerId === agentEvent.steerId ? { ...entry, delivered: true } : entry);
  }
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
    case "turn_started": {
      // 1 つの Agent が同時に動かすターンは 1 つ。閉じていない前のターン（Hub が作業中に止まったもの）は中断にする
      const closed = items.map((entry) => entry.kind === "turn" && entry.agent === agent && entry.status === "working"
        ? { ...entry, status: "interrupted" as const } : entry);
      return limit([...closed, newTurn()]);
    }
    case "text":
      return updateTurn((turn) => (turn.plan === undefined
        ? { ...turn, plan: agentEvent.text, planAt: at }
        : { ...turn, steps: [...turn.steps, { kind: "say", text: agentEvent.text, at }] }));
    case "tool":
      return updateTurn((turn) => ({ ...turn, steps: [...turn.steps, { kind: "tool", name: agentEvent.name, input: agentEvent.input, ...(agentEvent.files ? { files: agentEvent.files } : {}) }] }));
    case "turn": {
      const { status, text } = agentEvent.result;
      const finish = (turn: Turn): Turn => {
        const last = turn.steps[turn.steps.length - 1];
        // 最終応答は本文として出すので、同じ内容の最後の発言は作業から外す
        const steps = last?.kind === "say" && last.text.trim() === text.trim() ? turn.steps.slice(0, -1) : turn.steps;
        // 発言が最終応答だけなら、方針として重ねて出さない
        if (turn.plan !== undefined && turn.plan.trim() === text.trim()) {
          const { plan: _same, planAt: _sameAt, ...rest } = turn;
          return { ...rest, status, text, steps };
        }
        return { ...turn, status, text, steps };
      };
      const index = items.findLastIndex((entry) => entry.kind === "turn" && entry.agent === agent && entry.status === "working");
      // 自分が送った質問・message はターンの一部なので、枠を分ける理由にしない
      const ownItem = (entry: TimelineItem) => (entry.kind === "question" && entry.agent === agent)
        || (entry.kind === "message" && entry.message.from === agent);
      const later = items.slice(index + 1).some((entry) => !ownItem(entry) && (entry.kind !== "turn" || entry.status !== "working"));
      if (index < 0 || !later) return updateTurn(finish);
      // 作業中に後ろへ別の項目が並んだら、最終応答は末尾に出してログを時系列に保つ（DESIGN.md §17 ログ）
      const finished = finish(items[index] as Turn);
      const result: Turn = { kind: "turn", id, at, agent, status, steps: [], text };
      if (finished.plan === undefined && finished.steps.length === 0) return limit([...items.slice(0, index), ...items.slice(index + 1), result]);
      return limit([...items.slice(0, index), { ...finished, text: "", resultId: id }, ...items.slice(index + 1), { ...result, processId: finished.id }]);
    }
    case "error":
      return limit([...items, { kind: "error", id, at, agent, text: agentEvent.message }]);
    case "compacted":
      return limit([...items, { kind: "notice", id, at, text: `${agent}: compacted` }]);
    default:
      return items;
  }
}

export type WorkingEntry =
  | { kind: "head"; turnId: string; agent: AgentId; at: string; plan?: string; done?: true }
  | { kind: "say"; agent: AgentId; text: string };

// 作業ログ（DESIGN.md §28 作業ログ）: Agent ごとに直近のターンの発言を時系列に並べ、発言のターンが変わるところに見出しを挟む
export function workingFeed(items: readonly TimelineItem[]): WorkingEntry[] {
  type Turn = Extract<TimelineItem, { kind: "turn" }>;
  const RECENT_TURNS = 2;
  const counts: Partial<Record<AgentId, number>> = {};
  const turns: Turn[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    // 最終応答だけを末尾に出した項目は、元の枠と同じターンなので数えない
    if (item?.kind !== "turn" || item.processId !== undefined) continue;
    const count = counts[item.agent] ?? 0;
    if (count >= RECENT_TURNS) continue;
    counts[item.agent] = count + 1;
    turns.unshift(item);
  }
  const says = turns.flatMap((turn) => [
    ...(turn.plan === undefined ? [] : [{ turn, text: turn.plan, at: turn.planAt ?? turn.at }]),
    ...turn.steps.flatMap((step) => step.kind === "say" ? [{ turn, text: step.text, at: step.at }] : []),
  ]);
  // 発言の無いターンは開始の位置に見出しだけを置く
  const events: Array<{ turn: Turn; at: string; text?: string }> = [
    ...says,
    ...turns.filter((turn) => !says.some((say) => say.turn === turn)).map((turn) => ({ turn, at: turn.at })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const entries: WorkingEntry[] = [];
  let current: Turn | undefined;
  for (const event of events) {
    if (event.turn !== current) {
      const { id, agent, at, plan } = event.turn;
      // 直後の発言が方針そのものなら、見出しには重ねて出さない
      const showPlan = plan !== undefined && event.text !== plan;
      entries.push({ kind: "head", turnId: id, agent, at, ...(showPlan ? { plan } : {}), ...(event.turn.status === "working" ? {} : { done: true as const }) });
      current = event.turn;
    }
    if (event.text !== undefined) entries.push({ kind: "say", agent: event.turn.agent, text: event.text });
  }
  return entries;
}

export function rebuildTimeline(history: readonly HistoryItem[], apply: typeof applyFeedItem): TimelineItem[] {
  return history.reduce<TimelineItem[]>(apply, []);
}
