// Ink に渡す前の分類と編集操作。端末 I/O を含めない。
import { applyFeedItem, type TimelineItem } from "../web/client/timeline.js";
import type { FeedItem } from "../web/web-feed.js";
import type { MessageType } from "../protocol/messages.js";
import { isShellInput } from "../web/client/shell-input.js";
import { marked, type Token, type Tokens } from "marked";

export interface StaticItem { item: TimelineItem; expanded: boolean; elapsedSeconds?: number; }
export interface TerminalFeed { timeline: TimelineItem[]; completed: StaticItem[]; }

export const advanceTerminalFeed = (state: TerminalFeed, feed: FeedItem, expanded: boolean): TerminalFeed => {
  if (feed.type === "state" || feed.type === "version" || feed.type === "toast" || feed.type === "gui" || feed.type === "gui_command") return state;
  if (feed.type === "reset") return { timeline: [], completed: state.completed };
  if (feed.type === "output") {
    return { ...state, completed: [...state.completed, { item: { kind: "output", id: `o${feed.seq}`, text: feed.text }, expanded }] };
  }
  if (feed.event.kind === "answer") {
    const answer = feed.event;
    return { ...state, completed: state.completed.map((entry) => entry.item.kind === "question" && entry.item.id === answer.id
      ? { ...entry, item: { ...entry.item, answers: answer.answers } } : entry) };
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

export type InlineStyle = "plain" | "bold" | "code" | "link" | "italic" | "strikethrough";
export interface InlinePart { text: string; style: InlineStyle; }
export interface MarkdownBlock {
  kind: "heading" | "paragraph" | "bullet" | "ordered" | "code" | "hr" | "table";
  parts: InlinePart[];
  level?: number;
  number?: number;
  language?: string;
  depth?: number;
  quoteDepth?: number;
  table?: { header: InlinePart[][]; rows: InlinePart[][][] };
}

const safeLink = (href: string): boolean => {
  try { return ["http:", "https:"].includes(new URL(href).protocol); }
  catch { return false; }
};

const inlineParts = (tokens: readonly Token[], style: InlineStyle = "plain"): InlinePart[] => tokens.flatMap((token): InlinePart[] => {
  switch (token.type) {
    case "strong": return inlineParts(token.tokens ?? [], "bold");
    case "em": return inlineParts(token.tokens ?? [], "italic");
    case "del": return inlineParts(token.tokens ?? [], "strikethrough");
    case "link": return inlineParts(token.tokens ?? [], safeLink(token.href) ? "link" : style);
    case "codespan": return [{ text: token.text, style: "code" }];
    case "image": return [{ text: token.text, style }];
    case "br": return [{ text: "\n", style: "plain" }];
    case "html": return [{ text: token.text, style }];
    default:
      if ("tokens" in token && Array.isArray(token.tokens)) return inlineParts(token.tokens, style);
      return "text" in token && typeof token.text === "string" ? [{ text: token.text, style }] : [];
  }
});

export const formatMarkdown = (text: string): MarkdownBlock[] => {
  const blocks: MarkdownBlock[] = [];
  const visit = (tokens: readonly Token[], depth = 0, quoteDepth = 0) => {
    for (const token of tokens) {
      switch (token.type) {
        case "space": case "def": break;
        case "blockquote": visit(token.tokens ?? [], depth, quoteDepth + 1); break;
        case "heading": blocks.push({ kind: "heading", level: token.depth, parts: inlineParts(token.tokens ?? []), depth, quoteDepth }); break;
        case "paragraph": case "text": blocks.push({ kind: "paragraph", parts: inlineParts(token.tokens ?? [token]), depth, quoteDepth }); break;
        case "html": blocks.push({ kind: "paragraph", parts: [{ text: token.text, style: "plain" }], depth, quoteDepth }); break;
        case "code": blocks.push({ kind: "code", parts: [{ text: token.text, style: "code" }], language: token.lang, depth, quoteDepth }); break;
        case "hr": blocks.push({ kind: "hr", parts: [], depth, quoteDepth }); break;
        case "table": blocks.push({ kind: "table", parts: [], depth, quoteDepth, table: {
          header: token.header.map((cell: Tokens.TableCell) => inlineParts(cell.tokens)),
          rows: token.rows.map((row: Tokens.TableCell[]) => row.map((cell: Tokens.TableCell) => inlineParts(cell.tokens))),
        } }); break;
        case "list": {
          const start = typeof token.start === "number" ? token.start : 1;
          token.items.forEach((item: Tokens.ListItem, index: number) => {
            const content = item.tokens.filter((child) => child.type !== "list");
            blocks.push({ kind: token.ordered ? "ordered" : "bullet", parts: inlineParts(content),
              ...(token.ordered ? { number: start + index } : {}), depth, quoteDepth });
            for (const child of item.tokens) if (child.type === "list") visit([child], depth + 1, quoteDepth);
          });
          break;
        }
        default: break;
      }
    }
  };
  visit(marked.lexer(text, { gfm: true, breaks: true }));
  return blocks;
};

export interface TerminalLabels {
  you: string; working: string; completed: string; failed: string; interrupted: string;
  question: string; answered: string;
  steps: string; message: string; notice: string; error: string; output: string;
  steer: string; steerSent: string; steerDelivered: string;
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
  headerBackgroundColor?: string;
}

export const TERMINAL_COLORS = {
  line: "#d4d4d8", muted: "#80808a", warn: "#b7791f", claude: "#b4793f",
  codex: "#4b6fa5", code: "#6f9a5a", error: "#d14343", review: "#8159a8",
  humanHeader: "#323234", claudeHeader: "#3c3025", codexHeader: "#272e39",
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

const SGR_MOUSE_PATTERN = /\x1b\[<\d+;\d+;\d+[Mm]/g;
export const splitMouseInput = (chunk: string): { wheel: ("up" | "down")[]; rest: string } => {
  const wheel: ("up" | "down")[] = [];
  let rest = "";
  let cursor = 0;
  for (const match of chunk.matchAll(SGR_MOUSE_PATTERN)) {
    rest += chunk.slice(cursor, match.index);
    const direction = parseSgrMouse(match[0]);
    if (direction === "up" || direction === "down") wheel.push(direction);
    cursor = match.index + match[0].length;
  }
  return { wheel, rest: rest + chunk.slice(cursor) };
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

export const inputFrame = (text: string, label: string, width: number): { color: string; top?: string } => {
  if (!isShellInput(text)) return { color: TERMINAL_COLORS.line };
  const start = `╭─ ${label} `;
  const end = "╮";
  return { color: TERMINAL_COLORS.code, top: `${start}${"─".repeat(Math.max(0, width - textWidth(start + end)))}${end}` };
};

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

export interface TerminalSegment { text: string; color?: string; bold?: boolean; underline?: boolean; italic?: boolean; strikethrough?: boolean; }
export interface TerminalLine extends TerminalSegment { parts?: TerminalSegment[]; backgroundColor?: string; quoteDepth?: number; }
const TABLE_CELL_PADDING_WIDTH = 2;
const TABLE_BORDER_WIDTH = 1;
const wrapSegments = (segments: TerminalSegment[], width: number): TerminalSegment[][] => {
  const lines: TerminalSegment[][] = [[]];
  let columns = 0;
  for (const segment of segments) {
    for (const char of segment.text) {
      if (char === "\n") { lines.push([]); columns = 0; continue; }
      const size = characterWidth(char);
      if (columns + size > width && columns > 0) { lines.push([]); columns = 0; }
      const current = lines.at(-1);
      if (!current) continue;
      const last = current.at(-1);
      if (last && last.color === segment.color && last.bold === segment.bold && last.underline === segment.underline
        && last.italic === segment.italic && last.strikethrough === segment.strikethrough) last.text += char;
      else current.push({ ...segment, text: char });
      columns += size;
    }
  }
  return lines;
};
export const cardLines = (card: TerminalCard, width: number, elapsedLabel?: string): TerminalLine[] => {
  const divider = card.kind === "message" ? "┃" : "│";
  const contentWidth = Math.max(1, width - 2);
  const inlineSegments = (parts: InlinePart[], heading = false): TerminalSegment[] => parts.map((part) => ({
    text: part.text, bold: heading || part.style === "bold", underline: part.style === "link",
    italic: part.style === "italic", strikethrough: part.style === "strikethrough",
    color: part.style === "code" ? TERMINAL_COLORS.code : undefined,
  }));
  const tableLines = (block: MarkdownBlock): TerminalLine[] => {
    const table = block.table;
    if (!table) return [];
    const rows = [table.header, ...table.rows];
    const widths = table.header.map((_, column) => Math.max(1, ...rows.map((row) => textWidth(row[column]?.map((part) => part.text).join("") ?? ""))));
    const quoteWidth = textWidth("│ ".repeat(block.quoteDepth ?? 0));
    const tableBorderWidth = (TABLE_CELL_PADDING_WIDTH + TABLE_BORDER_WIDTH) * widths.length + TABLE_BORDER_WIDTH;
    const capacity = Math.max(widths.length, contentWidth - quoteWidth - tableBorderWidth);
    while (widths.reduce((sum, column) => sum + column, 0) > capacity) {
      const widest = widths.indexOf(Math.max(...widths));
      if (widths[widest] === 1) break;
      widths[widest]!--;
    }
    const border = (left: string, middle: string, right: string): TerminalLine => ({
      text: `${left}${widths.map((column) => "─".repeat(column + TABLE_CELL_PADDING_WIDTH)).join(middle)}${right}`,
      color: TERMINAL_COLORS.muted, quoteDepth: block.quoteDepth,
    });
    const row = (cells: InlinePart[][]): TerminalLine[] => {
      const wrapped = cells.map((cell, column) => wrapSegments(inlineSegments(cell), widths[column] ?? 1));
      const height = Math.max(...wrapped.map((lines) => lines.length));
      return Array.from({ length: height }, (_, lineIndex) => {
        const parts: TerminalSegment[] = [{ text: "│", color: TERMINAL_COLORS.muted }];
        wrapped.forEach((lines, column) => {
          const cell = lines[lineIndex] ?? [];
          const value = cell.map((part) => part.text).join("");
          parts.push({ text: " ", color: TERMINAL_COLORS.muted }, ...cell,
            { text: `${" ".repeat(Math.max(0, (widths[column] ?? 1) - textWidth(value)))} │`, color: TERMINAL_COLORS.muted });
        });
        return { text: parts.map((part) => part.text).join(""), parts, quoteDepth: block.quoteDepth };
      });
    };
    return [border("┌", "┬", "┐"), ...row(table.header), border("├", "┼", "┤"), ...table.rows.flatMap(row), border("└", "┴", "┘")];
  };
  const content: TerminalLine[] = [
    { text: `${card.title}${elapsedLabel === undefined ? "" : ` · ${elapsedLabel}`}`, color: card.color, bold: true },
    ...(card.tag ? [{ text: card.tag, color: card.color }] : []),
    ...(card.plan ? [{ text: card.plan, color: TERMINAL_COLORS.muted }] : []),
    ...(card.stepsLabel ? [{ text: `${card.steps ? "▾" : "▸"} ${card.stepsLabel}`, color: TERMINAL_COLORS.muted }] : []),
    ...(card.steps ?? []).map((step) => ({ text: `  • ${step}`, color: TERMINAL_COLORS.muted })),
    ...(card.kind === "question" ? card.body.split("\n").map((text): TerminalLine => ({ text })) : formatMarkdown(card.body).flatMap((block): TerminalLine[] => {
      const value = block.parts.map((part) => part.text).join("");
      if (block.kind === "table") return tableLines(block);
      if (block.kind === "hr") return [{ text: "─".repeat(contentWidth), color: TERMINAL_COLORS.muted, quoteDepth: block.quoteDepth }];
      if (block.kind === "code") return [{ text: `┌ ${block.language ?? ""}`, color: TERMINAL_COLORS.code, quoteDepth: block.quoteDepth },
        ...value.split("\n").map((line) => ({ text: `│ ${line}`, color: TERMINAL_COLORS.code, quoteDepth: block.quoteDepth })),
        { text: "└", color: TERMINAL_COLORS.code, quoteDepth: block.quoteDepth }];
      const marker = block.kind === "bullet" ? "• " : block.kind === "ordered" ? `${block.number}. ` : "";
      const prefix = `${"  ".repeat(block.depth ?? 0)}${marker}`;
      const parts: TerminalSegment[] = [
        ...(prefix ? [{ text: prefix, color: TERMINAL_COLORS.muted }] : []),
        ...inlineSegments(block.parts, block.kind === "heading"),
      ];
      return [{ text: `${prefix}${value}`, parts, quoteDepth: block.quoteDepth }];
    })),
  ];
  const lines: TerminalLine[] = [...content.flatMap((line) => {
    const quotePrefix = "│ ".repeat(line.quoteDepth ?? 0);
    const quotePart: TerminalSegment[] = quotePrefix ? [{ text: quotePrefix, color: TERMINAL_COLORS.muted }] : [];
    return wrapSegments(line.parts ?? [line], Math.max(1, contentWidth - textWidth(quotePrefix))).map((wrapped) => {
      const parts = [...quotePart, ...wrapped];
      return { text: `${divider} ${parts.map((part) => part.text).join("")}`,
        parts: [{ text: `${divider} `, color: card.color, bold: true }, ...parts] };
    });
  }), { text: "" }];
  const header = lines[0];
  if (header && card.headerBackgroundColor) {
    const padding = " ".repeat(Math.max(0, width - textWidth(header.text)));
    lines[0] = { ...header, text: `${header.text}${padding}`,
      parts: [...(header.parts ?? []), { text: padding }], backgroundColor: card.headerBackgroundColor };
  }
  return lines;
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
const agentHeaderColor = (id: string): string => id === "claude" ? TERMINAL_COLORS.claudeHeader : TERMINAL_COLORS.codexHeader;
const MESSAGE_COLORS: Record<MessageType, string> = {
  QUESTION: TERMINAL_COLORS.warn, REVIEW_REQUEST: TERMINAL_COLORS.review, DELEGATE: TERMINAL_COLORS.claude,
  RESULT: TERMINAL_COLORS.codex, ISSUE: TERMINAL_COLORS.error, ACK: TERMINAL_COLORS.muted,
};

export const formatTimelineItem = (item: TimelineItem, labels: TerminalLabels, expanded: boolean): TerminalCard => {
  if (item.kind === "question") return {
    kind: item.kind, color: agentColor(item.agent), title: `${agentName(item.agent)} · ${item.answers ? labels.answered : labels.question}`,
    tag: item.id,
    body: item.questions.map((question, index) => [question.header, question.question,
      ...(item.answers ? [item.answers[index]!.join(", ")] : question.options.map((option, optionIndex) =>
        `${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`)),
    ].filter(Boolean).join("\n")).join("\n\n"),
  };
  if (item.kind === "turn") return {
    kind: item.kind, color: agentColor(item.agent), title: `${agentName(item.agent)} · ${labels[item.status]}`,
    headerBackgroundColor: agentHeaderColor(item.agent),
    body: item.text, at: item.at, ...(item.plan ? { plan: item.plan } : {}),
    ...(item.steps.length ? {
      stepsLabel: labels.steps.replace("{count}", String(item.steps.length)),
      ...(expanded ? { steps: item.steps.map((step) => step.kind === "say" ? step.text : `${step.name}: ${step.input}`) } : {}),
    } : {}),
  };
  if (item.kind === "message") return {
    kind: item.kind, color: MESSAGE_COLORS[item.message.type],
    headerBackgroundColor: agentHeaderColor(item.message.from),
    title: `${agentName(item.message.from)} → ${agentName(item.message.to)}`,
    tag: `${item.message.type} · ${item.message.taskId}`, body: item.message.body,
  };
  if (item.kind === "human") return { kind: item.kind, color: TERMINAL_COLORS.muted,
    headerBackgroundColor: TERMINAL_COLORS.humanHeader, title: `${labels.you} → ${agentName(item.agent)}`, body: item.text,
    ...(item.steer ? { tag: `${labels.steer} · ${item.delivered ? labels.steerDelivered : labels.steerSent}` } : {}) };
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
