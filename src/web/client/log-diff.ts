import { type TimelineItem, type TurnContent, turnContent } from "./timeline.js";

type Turn = Extract<TimelineItem, { kind: "turn" }>;

const sameBlock = (a: TurnContent | undefined, b: TurnContent): boolean => {
  if (!a || a.key !== b.key) return false;
  if (a.kind === "say" && b.kind === "say") return a.text === b.text && a.at === b.at;
  if (a.kind === "tools" && b.kind === "tools") return a.steps.length === b.steps.length && a.steps.every((step, index) => step === b.steps[index]);
  return (a.kind === "message" && b.kind === "message" && a.entry === b.entry) || (a.kind === "question" && b.kind === "question" && a.entry === b.entry);
};

export function diffTurn(previous: Turn, next: Turn) {
  const before = turnContent(previous);
  const content = turnContent(next);
  return {
    replace:
      previous.id !== next.id ||
      previous.agent !== next.agent ||
      previous.at !== next.at ||
      previous.status !== next.status ||
      previous.segment !== next.segment,
    content,
    blocks: content.flatMap((block, index) => (sameBlock(before[index], block) ? [] : [index])),
  };
}

export function discardMissingOpened(opened: Map<string, boolean>, keep: ReadonlySet<string>): void {
  for (const id of opened.keys()) if (!keep.has(id)) opened.delete(id);
}
