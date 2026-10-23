// feed からログの項目を組み立てる（DESIGN.md §17 Web UI）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない 1 つの関数として書く（型の import のみ）
import type { AgentId, AgentStatus, SubagentState, TurnResult } from "../../agents/agent-adapter.js";
import type { AgentMessage } from "../../protocol/messages.js";
import type { UserQuestion } from "../../protocol/questions.js";
import type { FeedItem, HistoryItem } from "../web-feed.js";

export { isCanceledHistoryItem, withoutCanceledHistoryItem } from "../web-feed.js";

export type TimelineStep = { kind: "say"; text: string; at: string } | { kind: "tool"; name: string; input: string; files?: string[] };

export type TimelineItem =
  | { kind: "question"; id: string; at: string; agent: AgentId; questions: UserQuestion[]; answers?: string[][] }
  | {
      kind: "human";
      id: string;
      at: string;
      agent: AgentId;
      text: string;
      inputId?: string;
      steer?: boolean;
      steerId?: string;
      delivered?: boolean;
      interrupted?: boolean;
      queued?: boolean;
      nextRound?: true;
    }
  | {
      kind: "turn";
      id: string;
      at: string;
      agent: AgentId;
      status: "working" | TurnResult["status"];
      segment?: "closed";
      continuation?: true;
      rootId?: string;
      steps: TimelineStep[];
      text: string;
      finalAt?: string;
      messages?: Array<{ message: AgentMessage; envelope?: string }>;
      questions?: Array<Extract<TimelineItem, { kind: "question" }>>;
      attachmentOrder?: Array<{ kind: "message" | "question"; id: string; stepIndex?: number }>;
    }
  | { kind: "message"; id: string; at: string; message: AgentMessage; envelope?: string }
  | { kind: "notice"; id: string; at: string; text: string; compactAgent?: AgentId }
  | { kind: "brainstorm"; id: string; at: string; phase: "round" | "summary"; round?: number; total: number }
  | { kind: "error"; id: string; at: string; agent: AgentId; text: string }
  | { kind: "output"; id: string; text: string };

export type DisplayTimelineItem =
  | TimelineItem
  | { kind: "starting"; id: string; at: string; agent: AgentId }
  | { kind: "subagents"; id: string; agent: AgentId; running: SubagentState[]; backgroundTasks?: SubagentState[] };

export const MAX_ITEMS = 1500;

export function limitLiveHistory(history: readonly HistoryItem[], item: HistoryItem): HistoryItem[] {
  const next = [...history, item];
  return next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
}

export function withWorkingTurnsLast(items: readonly TimelineItem[]): TimelineItem[] {
  return [
    ...items.filter(item => item.kind !== "turn" || item.status !== "working" || item.segment === "closed"),
    ...items.filter(item => item.kind === "turn" && item.status === "working" && item.segment !== "closed"),
  ];
}

export function withStartingTurns(
  items: readonly TimelineItem[],
  agents: readonly { id: AgentId; status: AgentStatus }[],
  now: string,
  pendingInputs: readonly { agent: AgentId }[] = [],
): DisplayTimelineItem[] {
  const result: DisplayTimelineItem[] = [...items];
  for (const agent of agents) {
    if (agent.status === "stopped") continue;
    const last = items.findLast(item => "agent" in item && item.agent === agent.id && ["human", "turn", "error"].includes(item.kind));
    if (agent.status === "busy" || pendingInputs.some(input => input.agent === agent.id)) {
      if (last?.kind === "human" && !last.queued && !last.steer && !last.nextRound) result[result.indexOf(last)] = { ...last, queued: true };
      continue;
    }
    if (last?.kind === "turn" && last.status === "working" && last.segment !== "closed") continue;
    const waiting = last?.kind === "human" && !last.steer && !last.queued;
    if (agent.status !== "starting" && !waiting) continue;
    result.push({ kind: "starting", id: `starting-${agent.id}`, at: last && "at" in last ? last.at : now, agent: agent.id });
  }
  return result;
}

export function withSubagentRows(
  items: readonly DisplayTimelineItem[],
  agents: readonly { id: AgentId; status: AgentStatus; subagents: readonly SubagentState[]; backgroundTasks?: readonly SubagentState[] }[],
): DisplayTimelineItem[] {
  const result = [...items];
  for (const agent of agents) {
    if (agent.status === "busy" || agent.status === "starting" || !(agent.subagents.length || agent.backgroundTasks?.length)) continue;
    if (items.some(item => item.kind === "starting" && item.agent === agent.id)) continue;
    result.push({
      kind: "subagents",
      id: `subagents-${agent.id}`,
      agent: agent.id,
      running: [...agent.subagents],
      ...(agent.backgroundTasks?.length ? { backgroundTasks: [...agent.backgroundTasks] } : {}),
    });
  }
  return result;
}

// 変更した項目だけを新しいオブジェクトにして返す（画面は項目の同一性で差分を描画する）
export function applyFeedItem(items: TimelineItem[], item: FeedItem, options: { maxItems?: number } = {}): TimelineItem[] {
  const maxItems = options.maxItems ?? MAX_ITEMS;
  const limit = (list: TimelineItem[]) => (list.length > maxItems ? list.slice(list.length - maxItems) : list);
  type Turn = Extract<TimelineItem, { kind: "turn" }>;
  type Question = Extract<TimelineItem, { kind: "question" }>;
  type Attachment = { kind: "message"; entry: { message: AgentMessage; envelope?: string } } | { kind: "question"; entry: Question };
  const hasAttachments = (turn: Turn) => Boolean(turn.messages?.length || turn.questions?.length);
  const appendAttachment = (turn: Turn, attachment: Attachment): Turn => {
    if (attachment.kind === "message")
      return {
        ...turn,
        messages: [...(turn.messages ?? []), attachment.entry],
        attachmentOrder: [...(turn.attachmentOrder ?? []), { kind: "message", id: attachment.entry.message.id, stepIndex: turn.steps.length }],
      };
    return {
      ...turn,
      questions: [...(turn.questions ?? []), attachment.entry],
      attachmentOrder: [...(turn.attachmentOrder ?? []), { kind: "question", id: attachment.entry.id, stepIndex: turn.steps.length }],
    };
  };
  const attachToTurn = (index: number, attachment: Attachment, at: string, split: boolean): TimelineItem[] => {
    const turn = items[index];
    if (turn?.kind !== "turn") return items;
    if (!split || turn.status !== "working") return [...items.slice(0, index), appendAttachment(turn, attachment), ...items.slice(index + 1)];
    const previous = items[index - 1];
    if (
      index === items.length - 1 &&
      turn.continuation &&
      !turn.steps.length &&
      !hasAttachments(turn) &&
      previous?.kind === "turn" &&
      previous.segment === "closed" &&
      previous.agent === turn.agent &&
      (previous.rootId ?? previous.id) === turn.rootId
    ) {
      return [...items.slice(0, index - 1), appendAttachment(previous, attachment), turn];
    }
    // 区切った枠は作業中として扱わない（次のターンの開始で中断にしたり、一番下へ寄せたりしない）。状態は画面に出さない
    const closed: Turn = { ...appendAttachment(turn, attachment), status: "completed", segment: "closed" };
    const continuation: Turn = {
      kind: "turn",
      id: `${id}-next`,
      at,
      agent: turn.agent,
      status: "working",
      steps: [],
      text: "",
      continuation: true,
      rootId: turn.rootId ?? turn.id,
    };
    return limit([...items.slice(0, index), ...items.slice(index + 1), closed, continuation]);
  };

  if (item.type === "state" || item.type === "version" || item.type === "toast" || item.type === "notify" || item.type === "gui" || item.type === "gui_command")
    return items;
  if (item.type === "reset") return [];
  if (item.type === "cancel") {
    const hasId = items.some(entry => (entry.kind === "human" && entry.inputId === item.id) || (entry.kind === "message" && entry.message.id === item.id));
    const legacyIndex = hasId
      ? -1
      : items.findLastIndex(entry => entry.kind === "human" && !entry.inputId && entry.agent === item.agent && entry.text === item.text);
    return items.flatMap((entry, index) => {
      if (index === legacyIndex) return [];
      if (entry.kind === "human" && entry.inputId === item.id) return [];
      if (entry.kind === "message" && entry.message.id === item.id) return [];
      if (entry.kind === "turn" && entry.messages?.some(message => message.message.id === item.id))
        return [
          {
            ...entry,
            messages: entry.messages.filter(message => message.message.id !== item.id),
            attachmentOrder: entry.attachmentOrder?.filter(attached => attached.id !== item.id),
          },
        ];
      return [entry];
    });
  }
  if (item.type === "output") {
    const last = items[items.length - 1];
    if (last?.kind === "output") return [...items.slice(0, -1), { ...last, text: `${last.text}\n${item.text}` }];
    return limit([...items, { kind: "output", id: `o${item.seq}`, text: item.text }]);
  }

  const id = `e${item.seq}`;
  const { event } = item;
  if (event.kind === "question") {
    let index = items.findLastIndex(entry => entry.kind === "turn" && entry.agent === event.agent && entry.status === "working" && entry.segment !== "closed");
    const last = items.at(-1);
    if (index < 0 && last?.kind === "turn" && last.agent === event.agent && last.status === "completed") index = items.length - 1;
    const question: Question = {
      kind: "question",
      id: event.id,
      agent: event.agent,
      at: event.at,
      questions: event.questions,
    };
    return index < 0 ? limit([...items, question]) : attachToTurn(index, { kind: "question", entry: question }, event.at, true);
  }
  if (event.kind === "answer")
    return items.map(entry => {
      if (entry.kind === "question" && entry.id === event.id) return { ...entry, answers: event.answers };
      if (entry.kind === "turn" && entry.questions?.some(question => question.id === event.id))
        return { ...entry, questions: entry.questions.map(question => (question.id === event.id ? { ...question, answers: event.answers } : question)) };
      return entry;
    });
  if (event.kind === "human") {
    return limit([
      ...items,
      {
        kind: "human",
        id,
        at: event.at,
        agent: event.agent,
        text: event.text,
        ...(event.inputId ? { inputId: event.inputId } : {}),
        ...(event.steer ? { steer: true } : {}),
        ...(event.steerId ? { steerId: event.steerId } : {}),
        ...(event.nextRound ? { nextRound: true } : {}),
      },
    ]);
  }
  if (event.kind === "notice" || event.kind === "retry") return items;
  if (event.kind === "spec_check")
    return items.map(entry => {
      if (entry.kind === "message" && entry.message.id === event.messageId) return { ...entry, message: { ...entry.message, specCheck: event.result } };
      if (entry.kind === "turn" && entry.messages?.some(attached => attached.message.id === event.messageId))
        return {
          ...entry,
          messages: entry.messages.map(attached =>
            attached.message.id === event.messageId ? { ...attached, message: { ...attached.message, specCheck: event.result } } : attached,
          ),
        };
      return entry;
    });
  if (event.kind === "brainstorm") {
    if (event.artifact) {
      const index = items.findLastIndex(entry => entry.kind === "turn" && entry.status === "completed");
      return items.map((entry, i) => {
        if (i !== index || entry.kind !== "turn") return entry;
        const text = `${entry.text}\n\n[資料](<${event.artifact}>)`;
        const lastSay = entry.steps.findLastIndex(step => step.kind === "say");
        const steps = entry.steps.map((step, index) =>
          index === lastSay && step.kind === "say" && step.text.trim() === entry.text.trim() ? { ...step, text } : step,
        );
        return { ...entry, text, steps };
      });
    }
    return limit([...items, { kind: "brainstorm", id, at: event.at, phase: event.phase, ...(event.round ? { round: event.round } : {}), total: event.total }]);
  }
  if (event.kind === "brainstormReleased")
    return items.map(entry => (entry.kind === "human" && entry.inputId === event.inputId ? { ...entry, nextRound: undefined } : entry));
  if (event.kind === "message") {
    if (event.message.type !== "ACK") {
      const from = event.message.from;
      let index = items.findLastIndex(entry => entry.kind === "turn" && entry.agent === from && entry.status === "working" && entry.segment !== "closed");
      if (index < 0 && event.message.auto) index = items.findLastIndex(entry => entry.kind === "turn" && entry.agent === from);
      const turn = items[index];
      if (turn?.kind === "turn") {
        const attached = { message: event.message, ...(item.envelope ? { envelope: item.envelope } : {}) };
        return attachToTurn(index, { kind: "message", entry: attached }, event.at, !event.message.auto);
      }
    }
    return limit([...items, { kind: "message", id, at: event.at, message: event.message, ...(item.envelope ? { envelope: item.envelope } : {}) }]);
  }
  if (event.kind === "canceled") return items;
  if (event.kind === "steered")
    return items.map(entry =>
      entry.kind === "human" && entry.inputId === event.inputId ? { ...entry, steer: true, steerId: event.steerId, queued: false } : entry,
    );

  const { agent, event: agentEvent, at } = event;
  if (agentEvent.type === "steer_delivered") {
    return items.map(entry => (entry.kind === "human" && entry.steerId === agentEvent.steerId ? { ...entry, delivered: true } : entry));
  }
  const newTurn = (): Turn => ({ kind: "turn", id, at, agent, status: "working", steps: [], text: "" });
  // その Agent の実行中のターンを更新する。開始を受け取っていなければ新しいターンとして受け止める
  const updateTurn = (update: (turn: Turn) => Turn): TimelineItem[] => {
    for (let i = items.length - 1; i >= 0; i--) {
      const candidate = items[i];
      if (candidate?.kind === "turn" && candidate.agent === agent && candidate.status === "working" && candidate.segment !== "closed") {
        return [...items.slice(0, i), update(candidate), ...items.slice(i + 1)];
      }
    }
    return limit([...items, update(newTurn())]);
  };

  switch (agentEvent.type) {
    case "turn_started": {
      // 1 つの Agent が同時に動かすターンは 1 つ。閉じていない前のターン（Hub が作業中に止まったもの）は中断にする
      const isUnfinished = (entry: TimelineItem): entry is Turn => entry.kind === "turn" && entry.agent === agent && entry.status === "working";
      const unfinished = items.filter(isUnfinished);
      const other = items.filter(entry => !isUnfinished(entry));
      return limit([...other, ...unfinished.map(entry => ({ ...entry, status: "interrupted" as const })), newTurn()]);
    }
    case "text":
      return updateTurn(turn => ({ ...turn, steps: [...turn.steps, { kind: "say", text: agentEvent.text, at }] }));
    case "tool":
      // message・質問はカードで出すので、送った tool の行は作業に入れない（tell_user は廃止前の保存分）
      if (/^(?:clodex\.|mcp__clodex__)(?:send_message|ask_user|tell_user)$/.test(agentEvent.name)) return items;
      return updateTurn(turn => ({
        ...turn,
        steps: [...turn.steps, { kind: "tool", name: agentEvent.name, input: agentEvent.input, ...(agentEvent.files ? { files: agentEvent.files } : {}) }],
      }));
    case "turn": {
      const { status, text } = agentEvent.result;
      if (status === "interrupted" && event.inputIds?.length) {
        items = items.map(entry =>
          entry.kind === "human" && event.inputIds?.includes(entry.inputId ?? entry.steerId ?? "") ? { ...entry, interrupted: true } : entry,
        );
      }
      const finish = (turn: Turn): Turn => {
        const last = turn.steps.findLast(step => step.kind === "say");
        const steps = text.trim() && last?.text.trim() !== text.trim() ? [...turn.steps, { kind: "say" as const, text, at }] : turn.steps;
        return { ...turn, status, text, finalAt: at, steps };
      };
      const index = items.findLastIndex(entry => entry.kind === "turn" && entry.agent === agent && entry.status === "working" && entry.segment !== "closed");
      if (index < 0) return limit([...items, finish(newTurn())]);
      const active = items[index] as Turn;
      const finalTextOnly = active.steps.length === 1 && active.steps[0]?.kind === "say" && active.steps[0].text.trim() === text.trim();
      if (active.continuation && (!active.steps.length || finalTextOnly) && !hasAttachments(active)) {
        const previousIndex = items.findLastIndex(
          (entry, i) =>
            i < index && entry.kind === "turn" && entry.agent === agent && entry.segment === "closed" && (entry.rootId ?? entry.id) === active.rootId,
        );
        const previous = items[previousIndex] as Turn | undefined;
        if (previous) {
          const completed = finish(previous);
          return limit(items.filter((_, i) => i !== index).map((entry, i) => (i === previousIndex ? completed : entry)));
        }
      }
      return limit([...items.slice(0, index), ...items.slice(index + 1), finish(active)]);
    }
    case "error":
      return limit([...items, { kind: "error", id, at, agent, text: agentEvent.message }]);
    case "compacted":
      return limit([...items, { kind: "notice", id, at, text: "", compactAgent: agent }]);
    default:
      return items;
  }
}

type Turn = Extract<TimelineItem, { kind: "turn" }>;
export type TurnContent =
  | { kind: "say"; key: string; text: string; at: string }
  | { kind: "tools"; key: string; steps: Array<Extract<TimelineStep, { kind: "tool" }>> }
  | { kind: "message"; key: string; entry: NonNullable<Turn["messages"]>[number] }
  | { kind: "question"; key: string; entry: Extract<TimelineItem, { kind: "question" }> };

export function turnContent(turn: Turn): TurnContent[] {
  const blocks: TurnContent[] = [];
  const steps = [...turn.steps];
  const lastSay = steps.findLast(step => step.kind === "say");
  if (turn.text.trim() && lastSay?.text.trim() !== turn.text.trim()) steps.push({ kind: "say", text: turn.text, at: turn.finalAt ?? turn.at });
  const hiddenFinal = turn.messages?.some(({ message }) => message.auto && (message.type === "RESULT" || message.type === "ANSWER"))
    ? steps.findLastIndex(step => step.kind === "say")
    : -1;
  const order = turn.attachmentOrder ?? [
    ...(turn.messages ?? []).map(entry => ({ kind: "message" as const, id: entry.message.id, stepIndex: turn.steps.length })),
    ...(turn.questions ?? []).map(entry => ({ kind: "question" as const, id: entry.id, stepIndex: turn.steps.length })),
  ];
  for (let index = 0; index <= steps.length; index++) {
    for (const attachment of order.filter(entry => (entry.stepIndex ?? turn.steps.length) === index)) {
      if (attachment.kind === "message") {
        const entry = turn.messages?.find(entry => entry.message.id === attachment.id);
        if (entry) blocks.push({ kind: "message", key: `message:${attachment.id}`, entry });
      } else {
        const entry = turn.questions?.find(entry => entry.id === attachment.id);
        if (entry) blocks.push({ kind: "question", key: `question:${attachment.id}`, entry });
      }
    }
    const step = steps[index];
    if (!step || index === hiddenFinal) continue;
    const key = `step:${index}`;
    if (step.kind === "say") blocks.push({ ...step, key });
    else {
      const last = blocks.at(-1);
      if (last?.kind === "tools") last.steps.push(step);
      else blocks.push({ kind: "tools", key, steps: [step] });
    }
  }
  return blocks;
}

export function rebuildTimeline(history: readonly HistoryItem[], apply: typeof applyFeedItem): TimelineItem[] {
  return history.reduce<TimelineItem[]>((items, item) => apply(items, item), []);
}

export function mergeReplayHistory(current: readonly HistoryItem[], incoming: readonly HistoryItem[]): { history: HistoryItem[]; preserved: boolean } {
  const oldest = incoming[0];
  if (!oldest) return { history: [...incoming], preserved: false };
  const matched = current.find(item => item.seq === oldest.seq);
  const same =
    matched?.type === oldest.type &&
    (oldest.type === "event"
      ? matched.type === "event" && matched.event.kind === oldest.event.kind && matched.event.at === oldest.event.at
      : matched.type === "output" && matched.text.startsWith(oldest.text.slice(0, 100)));
  if (!same) return { history: [...incoming], preserved: false };
  return { history: [...current.filter(item => item.seq < oldest.seq), ...incoming], preserved: true };
}

export function announcementKind(item: FeedItem): "work" | "failed" | "interrupted" | "question" | undefined {
  if (item.type !== "event") return undefined;
  if (item.event.kind === "question") return "question";
  if (item.event.kind !== "agent" || item.event.event.type !== "turn") return undefined;
  return item.event.event.result.status === "completed" ? "work" : item.event.event.result.status;
}
