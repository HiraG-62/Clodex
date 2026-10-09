import { findImagePaths } from "./artifacts.js";
import type { TimelineItem, TimelineStep, WorkingEntry } from "./timeline.js";

type Turn = Extract<TimelineItem, { kind: "turn" }>;
const pathKey = (path: string) => path.replace(/\\/g, "/").toLowerCase();

const sameStep = (a: TimelineStep, b: TimelineStep) =>
  a.kind === b.kind &&
  (a.kind === "say" && b.kind === "say"
    ? a.text === b.text && a.at === b.at
    : a.kind === "tool" && b.kind === "tool" && a.name === b.name && a.input === b.input && JSON.stringify(a.files) === JSON.stringify(b.files));

export function diffTurn(previous: Turn, next: Turn) {
  const steps = next.steps.flatMap((step, index) => (sameStep(previous.steps[index] ?? step, step) && index < previous.steps.length ? [] : [index]));
  const before = findImagePaths([previous.plan, previous.text].filter(Boolean).join("\n"));
  const after = findImagePaths([next.plan, next.text].filter(Boolean).join("\n"));
  const oldKeys = new Set(before.map(pathKey));
  const newKeys = new Set(after.map(pathKey));
  return {
    replace:
      previous.id !== next.id ||
      previous.agent !== next.agent ||
      previous.at !== next.at ||
      previous.steps.length > next.steps.length ||
      previous.messages !== next.messages ||
      previous.status !== "working" ||
      next.status !== "working",
    steps,
    plan: previous.plan !== next.plan,
    body: previous.text !== next.text,
    images: {
      paths: after,
      orderChanged: before.length === after.length && before.some((path, index) => pathKey(path) !== pathKey(after[index]!)),
      keep: after.filter(path => oldKeys.has(pathKey(path))),
      add: after.filter(path => !oldKeys.has(pathKey(path))),
      remove: before.filter(path => !newKeys.has(pathKey(path))),
    },
  };
}

export function sameWorkingEntry(a: WorkingEntry, b: WorkingEntry): boolean {
  if (a.kind !== b.kind || a.agent !== b.agent) return false;
  if (a.kind === "say" && b.kind === "say") return a.text === b.text;
  if (a.kind === "head" && b.kind === "head") return a.turnId === b.turnId && a.at === b.at && a.plan === b.plan && a.done === b.done;
  return false;
}

export function discardMissingOpened(opened: Map<string, boolean>, keep: ReadonlySet<string>): void {
  for (const id of opened.keys()) if (!keep.has(id)) opened.delete(id);
}
