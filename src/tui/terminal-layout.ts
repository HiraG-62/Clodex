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

const agentName = (id: string): string => id === "claude" ? "Claude" : id === "codex" ? "Codex" : id;
const agentColor = (id: string): string => id === "claude" ? "#b4793f" : "#4b6fa5";
const MESSAGE_COLORS: Record<MessageType, string> = {
  QUESTION: "#b7791f", REVIEW_REQUEST: "#8159a8", DELEGATE: "#b4793f",
  RESULT: "#4b6fa5", ISSUE: "#d14343", ACK: "#80808a",
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
  if (item.kind === "human") return { kind: item.kind, color: "#80808a", title: `${labels.you} → ${agentName(item.agent)}`, body: item.text };
  if (item.kind === "error") return { kind: item.kind, color: "#d14343", title: `${labels.error} · ${agentName(item.agent)}`, body: item.text };
  if (item.kind === "notice") return { kind: item.kind, color: "#b7791f", title: labels.notice, body: item.text };
  return { kind: item.kind, color: "#80808a", title: labels.output, body: item.text };
};

export interface InputBuffer { text: string; cursor: number; }
export type InputAction = { kind: "left" | "right" | "home" | "end" | "backspace" | "delete" } | { kind: "insert"; text: string } | { kind: "replace"; from: number; to: number; text: string };

export const editInput = (buffer: InputBuffer, action: InputAction): InputBuffer => {
  const { text } = buffer;
  const cursor = Math.min(text.length, Math.max(0, buffer.cursor));
  switch (action.kind) {
    case "left": return { text, cursor: Math.max(0, cursor - 1) };
    case "right": return { text, cursor: Math.min(text.length, cursor + 1) };
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
