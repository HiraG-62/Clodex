// Ink に渡す前の分類と編集操作。端末 I/O を含めない。
import { applyFeedItem, type TimelineItem } from "../web/client/timeline.js";
import type { FeedItem } from "../web/web-feed.js";
import type { MessageType } from "../protocol/messages.js";

export interface StaticItem { item: TimelineItem; expanded: boolean; elapsedSeconds?: number; }
export interface TerminalFeed { timeline: TimelineItem[]; completed: StaticItem[]; }

export const advanceTerminalFeed = (state: TerminalFeed, feed: FeedItem, expanded: boolean): TerminalFeed => {
  if (feed.type === "state" || feed.type === "version") return state;
  if (feed.type === "reset") return { timeline: [], completed: state.completed };
  if (feed.type === "output") {
    return { ...state, completed: [...state.completed, { item: { kind: "output", id: `o${feed.seq}`, text: feed.text }, expanded }] };
  }
  const next = applyFeedItem(state.timeline, feed);
  return {
    timeline: next.filter((item) => item.kind === "turn" && item.status === "working"),
    completed: [...state.completed, ...next.filter((item) => item.kind !== "turn" || item.status !== "working")
      .map((item) => ({ item, expanded, ...(item.kind === "turn" && feed.event.kind === "agent" ? {
        elapsedSeconds: Math.max(0, Math.floor((Date.parse(feed.event.at) - Date.parse(item.at)) / 1000)),
      } : {}) }))],
  };
};

export type InlineStyle = "plain" | "bold" | "code" | "link";
export interface InlinePart { text: string; style: InlineStyle; }
export interface MarkdownBlock { kind: "heading" | "paragraph" | "bullet" | "ordered" | "code"; parts: InlinePart[]; level?: number; number?: number; language?: string; }

const inlineParts = (line: string): InlinePart[] => {
  const parts: InlinePart[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const at = match.index;
    if (at > cursor) parts.push({ text: line.slice(cursor, at), style: "plain" });
    const token = match[0];
    if (token.startsWith("**") || token.startsWith("__")) parts.push({ text: token.slice(2, -2), style: "bold" });
    else if (token.startsWith("`")) parts.push({ text: token.slice(1, -1), style: "code" });
    else parts.push({ text: token.slice(1, token.indexOf("]")), style: "link" });
    cursor = at + token.length;
  }
  if (cursor < line.length) parts.push({ text: line.slice(cursor), style: "plain" });
  return parts;
};

export const formatMarkdown = (text: string): MarkdownBlock[] => {
  const blocks: MarkdownBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i] ?? "")) code.push(lines[i] ?? "");
      blocks.push({ kind: "code", parts: [{ text: code.join("\n"), style: "code" }], language: fence[1]?.trim() ?? "" });
      continue;
    }
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1]?.length, parts: inlineParts(heading[2] ?? "") }); continue; }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) { blocks.push({ kind: "bullet", parts: inlineParts(bullet[1] ?? "") }); continue; }
    const ordered = /^\s*(\d+)\.\s+(.+)$/.exec(line);
    if (ordered) { blocks.push({ kind: "ordered", number: Number(ordered[1]), parts: inlineParts(ordered[2] ?? "") }); continue; }
    blocks.push({ kind: "paragraph", parts: inlineParts(line) });
  }
  return blocks;
};

export interface TerminalLabels {
  you: string; working: string; completed: string; failed: string; interrupted: string;
  steps: string; message: string; notice: string; error: string; output: string;
}
export interface TerminalCard {
  kind: TimelineItem["kind"];
  color: string;
  title: string;
  body: string;
  tag?: string;
  plan?: string;
  stepsLabel?: string;
  steps?: string[];
  at?: string;
}

export const TERMINAL_COLORS = {
  line: "#d4d4d8", muted: "#80808a", warn: "#b7791f", claude: "#b4793f",
  codex: "#4b6fa5", code: "#6f9a5a", error: "#d14343", review: "#8159a8",
} as const;

export const WHEEL_LINES = 3;
const SGR_WHEEL_UP = 64;
const SGR_WHEEL_DOWN = 65;
const SGR_MODIFIER_MASK = 28;
export interface ScrollState { offset: number; unseen: boolean; }
export const clampScroll = (offset: number, total: number, height: number): number =>
  Math.max(0, Math.min(offset, Math.max(0, total - height)));
export const scrollBy = (state: ScrollState, delta: number, total: number, height: number): ScrollState => {
  const offset = clampScroll(state.offset + delta, total, height);
  return { offset, unseen: offset > 0 && state.unseen };
};
export const scrollToBottom = (): ScrollState => ({ offset: 0, unseen: false });
export const scrollAfterGrowth = (state: ScrollState, previous: number, total: number, height: number): ScrollState => {
  if (state.offset === 0) return scrollToBottom();
  const offset = clampScroll(state.offset + Math.max(0, total - previous), total, height);
  return { offset, unseen: offset > 0 && (state.unseen || total > previous) };
};
export const visibleRange = (total: number, height: number, offset: number): { start: number; end: number } => {
  const end = Math.max(0, total - clampScroll(offset, total, height));
  return { start: Math.max(0, end - Math.max(0, height)), end };
};

export const parseSgrMouse = (input: string): "up" | "down" | "other" | undefined => {
  const match = /^(?:\x1b)?\[<([0-9]+);[0-9]+;[0-9]+[Mm]$/.exec(input);
  if (!match) return undefined;
  const button = Number(match[1]);
  const direction = button & ~SGR_MODIFIER_MASK;
  if (direction === SGR_WHEEL_UP) return "up";
  if (direction === SGR_WHEEL_DOWN) return "down";
  return "other";
};

const characterWidth = (char: string): number => {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x1f || code === 0x7f) return 0;
  if (code >= 0x1100 && (code <= 0x115f || code >= 0x2329 && code <= 0x232a ||
    code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ||
    code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f ||
    code >= 0xff00 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300)) return 2;
  return 1;
};

export const textWidth = (value: string): number => [...value].reduce((sum, char) => sum + characterWidth(char), 0);

export const wrapText = (value: string, width: number): string[] => {
  const lines: string[] = [];
  const limit = Math.max(1, width);
  for (const source of value.split("\n")) {
    let line = "";
    let columns = 0;
    for (const char of source) {
      const size = characterWidth(char);
      if (columns + size > limit && line) { lines.push(line); line = ""; columns = 0; }
      line += char;
      columns += size;
    }
    lines.push(line);
  }
  return lines;
};

export interface TerminalSegment { text: string; color?: string; bold?: boolean; underline?: boolean; }
export interface TerminalLine extends TerminalSegment { parts?: TerminalSegment[]; }
const wrapSegments = (segments: TerminalSegment[], width: number): TerminalSegment[][] => {
  const lines: TerminalSegment[][] = [[]];
  let columns = 0;
  for (const segment of segments) {
    for (const char of segment.text) {
      const size = characterWidth(char);
      if (columns + size > width && columns > 0) { lines.push([]); columns = 0; }
      const current = lines.at(-1);
      if (!current) continue;
      const last = current.at(-1);
      if (last && last.color === segment.color && last.bold === segment.bold && last.underline === segment.underline) last.text += char;
      else current.push({ ...segment, text: char });
      columns += size;
    }
  }
  return lines;
};
export const cardLines = (card: TerminalCard, width: number, elapsedLabel?: string): TerminalLine[] => {
  const divider = card.kind === "message" ? "┃" : "│";
  const contentWidth = Math.max(1, width - 2);
  const content: TerminalLine[] = [
    { text: `${card.title}${elapsedLabel === undefined ? "" : ` · ${elapsedLabel}`}`, color: card.color, bold: true },
    ...(card.tag ? [{ text: card.tag, color: card.color }] : []),
    ...(card.plan ? [{ text: card.plan, color: TERMINAL_COLORS.muted }] : []),
    ...(card.stepsLabel ? [{ text: `${card.steps ? "▾" : "▸"} ${card.stepsLabel}`, color: TERMINAL_COLORS.muted }] : []),
    ...(card.steps ?? []).map((step) => ({ text: `  • ${step}`, color: TERMINAL_COLORS.muted })),
    ...formatMarkdown(card.body).flatMap((block): TerminalLine[] => {
      const value = block.parts.map((part) => part.text).join("");
      if (block.kind === "code") return [{ text: `┌ ${block.language ?? ""}`, color: TERMINAL_COLORS.code },
        ...value.split("\n").map((line) => ({ text: `│ ${line}`, color: TERMINAL_COLORS.code })), { text: "└", color: TERMINAL_COLORS.code }];
      const prefix = block.kind === "bullet" ? "• " : block.kind === "ordered" ? `${block.number}. ` : "";
      const parts: TerminalSegment[] = [
        ...(prefix ? [{ text: prefix, color: TERMINAL_COLORS.muted }] : []),
        ...block.parts.map((part) => ({ text: part.text, bold: block.kind === "heading" || part.style === "bold",
          underline: part.style === "link", color: part.style === "code" ? TERMINAL_COLORS.code : undefined })),
      ];
      return [{ text: `${prefix}${value}`, parts }];
    }),
  ];
  return [...content.flatMap((line) => wrapSegments(line.parts ?? [line], contentWidth).map((parts) => ({
    text: `${divider} ${parts.map((part) => part.text).join("")}`,
    parts: [{ text: `${divider} `, color: card.color, bold: true }, ...parts],
  }))), { text: "" }];
};

export class CardLineCache {
  private readonly cache = new WeakMap<TimelineItem, Map<string, TerminalLine[]>>();
  lines(item: TimelineItem, labels: TerminalLabels, expanded: boolean, width: number, elapsedLabel?: string): TerminalLine[] {
    if (item.kind === "turn" && item.status === "working") {
      return cardLines(formatTimelineItem(item, labels, expanded), width, elapsedLabel);
    }
    let entries = this.cache.get(item);
    if (!entries) { entries = new Map(); this.cache.set(item, entries); }
    const key = `${width}:${expanded}:${elapsedLabel ?? ""}`;
    const existing = entries.get(key);
    if (existing) return existing;
    const lines = cardLines(formatTimelineItem(item, labels, expanded), width, elapsedLabel);
    entries.set(key, lines);
    return lines;
  }
}

const agentName = (id: string): string => id === "claude" ? "Claude" : id === "codex" ? "Codex" : id;
const agentColor = (id: string): string => id === "claude" ? TERMINAL_COLORS.claude : TERMINAL_COLORS.codex;
const MESSAGE_COLORS: Record<MessageType, string> = {
  QUESTION: TERMINAL_COLORS.warn, REVIEW_REQUEST: TERMINAL_COLORS.review, DELEGATE: TERMINAL_COLORS.claude,
  RESULT: TERMINAL_COLORS.codex, ISSUE: TERMINAL_COLORS.error, ACK: TERMINAL_COLORS.muted,
};

export const formatTimelineItem = (item: TimelineItem, labels: TerminalLabels, expanded: boolean): TerminalCard => {
  if (item.kind === "turn") return {
    kind: item.kind, color: agentColor(item.agent), title: `${agentName(item.agent)} · ${labels[item.status]}`,
    body: item.text, at: item.at, ...(item.plan ? { plan: item.plan } : {}),
    ...(item.steps.length ? {
      stepsLabel: labels.steps.replace("{count}", String(item.steps.length)),
      ...(expanded ? { steps: item.steps.map((step) => step.kind === "say" ? step.text : `${step.name}: ${step.input}`) } : {}),
    } : {}),
  };
  if (item.kind === "message") return {
    kind: item.kind, color: MESSAGE_COLORS[item.message.type],
    title: `${agentName(item.message.from)} → ${agentName(item.message.to)}`,
    tag: `${item.message.type} · ${item.message.taskId}`, body: item.message.body,
  };
  if (item.kind === "human") return { kind: item.kind, color: TERMINAL_COLORS.muted, title: `${labels.you} → ${agentName(item.agent)}`, body: item.text };
  if (item.kind === "error") return { kind: item.kind, color: TERMINAL_COLORS.error, title: `${labels.error} · ${agentName(item.agent)}`, body: item.text };
  if (item.kind === "notice") return { kind: item.kind, color: TERMINAL_COLORS.warn, title: labels.notice, body: item.text };
  return { kind: item.kind, color: TERMINAL_COLORS.muted, title: labels.output, body: item.text };
};

export interface InputBuffer { text: string; cursor: number; }
export type InputAction = { kind: "left" | "right" | "up" | "down" | "home" | "end" | "backspace" | "delete" } | { kind: "insert"; text: string } | { kind: "replace"; from: number; to: number; text: string };

export const editInput = (buffer: InputBuffer, action: InputAction): InputBuffer => {
  const { text } = buffer;
  const cursor = Math.min(text.length, Math.max(0, buffer.cursor));
  switch (action.kind) {
    case "left": return { text, cursor: Math.max(0, cursor - 1) };
    case "right": return { text, cursor: Math.min(text.length, cursor + 1) };
    case "up": {
      const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
      if (lineStart === 0) return { text, cursor };
      const previousEnd = lineStart - 1;
      const previousStart = text.lastIndexOf("\n", previousEnd - 1) + 1;
      return { text, cursor: Math.min(previousStart + cursor - lineStart, previousEnd) };
    }
    case "down": {
      const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
      const lineEnd = text.indexOf("\n", cursor);
      if (lineEnd < 0) return { text, cursor };
      const nextStart = lineEnd + 1;
      const nextEnd = text.indexOf("\n", nextStart);
      return { text, cursor: Math.min(nextStart + cursor - lineStart, nextEnd < 0 ? text.length : nextEnd) };
    }
    case "home": return { text, cursor: text.lastIndexOf("\n", cursor - 1) + 1 };
    case "end": { const end = text.indexOf("\n", cursor); return { text, cursor: end < 0 ? text.length : end }; }
    case "backspace": return cursor === 0 ? { text, cursor } : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
    case "delete": return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
    case "insert": return { text: text.slice(0, cursor) + action.text + text.slice(cursor), cursor: cursor + action.text.length };
    case "replace": return { text: text.slice(0, action.from) + action.text + text.slice(action.to), cursor: action.from + action.text.length };
  }
};

export const cursorSlices = ({ text, cursor }: InputBuffer): { before: string; at: string; after: string } => {
  const at = Math.min(text.length, Math.max(0, cursor));
  if (text.charAt(at) === "\n") return { before: text.slice(0, at), at: " ", after: text.slice(at) };
  return { before: text.slice(0, at), at: text.charAt(at) || " ", after: text.slice(at + 1) };
};
