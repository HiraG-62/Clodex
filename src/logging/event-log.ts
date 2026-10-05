// Event Bus の購読者として terminal 表示と JSONL 記録を行う（DESIGN.md §17）
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentEvent, RateLimitWindow } from "../agents/agent-adapter.js";
import type { CoordinatorEvent, EventBus } from "../coordinator/event-bus.js";

const LOG_DIR = join(".clodex", "logs");
const LOG_EXTENSION = ".jsonl";
// 複数行の event は 2 行目以降をインデントし、どの event の続きか分かるようにする
const CONTINUATION_INDENT = "    ";

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
    case "turn": return `turn ${event.result.status}`;
    case "rate_limit": return `usage ${[...usage("5h", event.fiveHour), ...usage("7d", event.weekly)].join(" / ")}`;
    case "exit": return `exited (code ${event.code})`;
    case "error": return `ERROR ${event.message}`;
  }
};

const indentContinuation = (text: string) => text.replace(/\r?\n/g, `\n${CONTINUATION_INDENT}`);

export const formatEvent = (event: CoordinatorEvent): string => {
  const time = timeOf(event.at);
  if (event.kind === "agent") {
    return `${time} [${event.agent.toUpperCase()}] ${indentContinuation(describeAgentEvent(event.event))}`;
  }
  const { from, to, type, taskId, id, replyTo } = event.message;
  return `${time} [MESSAGE] ${from} -> ${to} ${type} task=${taskId} id=${id}${replyTo ? ` replyTo=${replyTo}` : ""}`;
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
}

export const attachEventLog = (bus: EventBus, { path, print }: EventLogOptions): (() => void) => {
  const write = createJsonlWriter(path);
  return bus.subscribe((event) => {
    write(event);
    print(formatEvent(event));
  });
};
