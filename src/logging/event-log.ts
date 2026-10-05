// Event Bus の購読者として terminal 表示と JSONL 記録を行う（DESIGN.md §17）
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentEvent, RateLimitWindow } from "../agents/agent-adapter.js";
import type { CoordinatorEvent, EventBus } from "../coordinator/event-bus.js";
import type { AgentMessage } from "../protocol/messages.js";

const LOG_DIR = join(".clodex", "logs");
const LOG_EXTENSION = ".jsonl";
// 複数行の event は 2 行目以降をインデントし、どの event の続きか分かるようにする
const CONTINUATION_INDENT = "    ";
const MESSAGE_PREVIEW_LENGTH = 80;

export type DisplayMode = "normal" | "verbose";

const pad2 = (n: number) => String(n).padStart(2, "0");
const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const usage = (label: string, w: RateLimitWindow | undefined) => (w ? [`${label} ${w.usedPercent}%`] : []);

const describeAgentEvent = (event: AgentEvent): string => {
  switch (event.type) {
    case "session": return `session ${event.sessionId}`;
    case "text": return event.text;
    case "tool": return `tool ${event.name} ${event.input}`;
    case "turn_started": return "working...";
    case "turn": return `turn ${event.result.status}`;
    case "rate_limit": return `usage ${[...usage("5h", event.fiveHour), ...usage("7d", event.weekly)].join(" / ")}`;
    case "compacted": return "compacted";
    case "context": return `context ${event.tokens} tokens${event.window ? ` / ${event.window}` : ""}`;
    case "exit": return `exited (code ${event.code})`;
    case "error": return `ERROR ${event.message}`;
  }
};

const indentContinuation = (text: string) => text.replace(/\r?\n/g, `\n${CONTINUATION_INDENT}`);

// 既定表示: 誰が何をしていて、誰が誰に何を頼んだかだけを出す（DESIGN.md §17）
const describeNormal = (event: AgentEvent): string | undefined => {
  switch (event.type) {
    case "turn_started": return "working...";
    case "error": return `ERROR ${event.message}`;
    case "turn": {
      const { status, text } = event.result;
      if (status === "completed") return text || "done";
      return status === "interrupted" ? "interrupted" : `failed: ${text}`;
    }
    default: return undefined;
  }
};

const preview = (body: string) => {
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > MESSAGE_PREVIEW_LENGTH ? `${firstLine.slice(0, MESSAGE_PREVIEW_LENGTH)}...` : firstLine;
};

const formatMessage = ({ from, to, type, taskId, id, replyTo, body }: AgentMessage, mode: DisplayMode) =>
  mode === "verbose"
    ? `[MESSAGE] ${from} -> ${to} ${type} task=${taskId} id=${id}${replyTo ? ` replyTo=${replyTo}` : ""}`
    : `[MESSAGE] ${from} -> ${to} ${type} task=${taskId} "${preview(body)}"`;

export const formatEvent = (event: CoordinatorEvent, mode: DisplayMode): string | undefined => {
  const time = timeOf(event.at);
  switch (event.kind) {
    case "message":
      return `${time} ${formatMessage(event.message, mode)}`;
    case "notice":
      return `${time} [CLODEX] ${event.text}`;
    case "human":
      // 既定では入力行が画面に残っているので出さない
      return mode === "verbose" ? `${time} [YOU -> ${event.agent.toUpperCase()}] ${indentContinuation(event.text)}` : undefined;
    case "agent": {
      const text = mode === "verbose" ? describeAgentEvent(event.event) : describeNormal(event.event);
      return text === undefined ? undefined : `${time} [${event.agent.toUpperCase()}] ${indentContinuation(text)}`;
    }
  }
};

export const createJsonlWriter = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  return (event: CoordinatorEvent): void => appendFileSync(path, `${JSON.stringify(event)}\n`);
};

// project の working tree を汚さないよう、ホームディレクトリに置く
export const defaultLogPath = (projectRoot: string, startedAt: Date): string => {
  const d = startedAt;
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return join(homedir(), LOG_DIR, `${basename(projectRoot)}-${stamp}${LOG_EXTENSION}`);
};

export interface EventLogOptions {
  path: string;
  print: (line: string) => void;
  mode: () => DisplayMode;
}

// file には常に全 event、terminal には表示モードに応じて出す
export const attachEventLog = (bus: EventBus, { path, print, mode }: EventLogOptions): (() => void) => {
  const write = createJsonlWriter(path);
  return bus.subscribe((event) => {
    write(event);
    const line = formatEvent(event, mode());
    if (line !== undefined) print(line);
  });
};
