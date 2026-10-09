// 設計書の前回からの差分を、変わった節の見出しで表す（DESIGN.md §13 Spec の差分）
const HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;
const TOP_SECTION = "(top)";
const REMOVED_PREFIX = "(removed) ";
export const MAX_LISTED_SPEC_CHANGES = 20;

interface Section {
  key: string;
  heading: string;
  content: string;
}

const splitSections = (text: string): Section[] => {
  const sections: Section[] = [];
  const occurrences = new Map<string, number>();
  let heading = TOP_SECTION;
  let lines: string[] = [];
  let inFence = false;
  const flush = () => {
    const content = lines.join("\n").trim();
    if (heading === TOP_SECTION && content === "") return;
    const count = (occurrences.get(heading) ?? 0) + 1;
    occurrences.set(heading, count);
    sections.push({ key: `${heading}\0${count}`, heading, content });
  };
  for (const line of text.split(/\r?\n/).map(raw => raw.trimEnd())) {
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence || !HEADING.test(line)) {
      lines.push(line);
      continue;
    }
    flush();
    heading = line;
    lines = [];
  }
  flush();
  return sections;
};

export const changedSections = (before: string, after: string): string[] => {
  const previous = new Map(splitSections(before).map(section => [section.key, section]));
  const current = splitSections(after);
  const currentKeys = new Set(current.map(section => section.key));
  const changed = [
    ...current.filter(section => previous.get(section.key)?.content !== section.content).map(section => section.heading),
    ...[...previous.values()].filter(section => !currentKeys.has(section.key)).map(section => `${REMOVED_PREFIX}${section.heading}`),
  ];
  if (changed.length <= MAX_LISTED_SPEC_CHANGES) return changed;
  return [...changed.slice(0, MAX_LISTED_SPEC_CHANGES), `…and ${changed.length - MAX_LISTED_SPEC_CHANGES} more`];
};
