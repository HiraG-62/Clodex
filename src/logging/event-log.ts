// Event Bus の購読者として terminal 表示と JSONL 記録を行う（DESIGN.md §17）
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentEvent, RateLimitWindow } from "../agents/agent-adapter.js";
import type { CoordinatorEvent, EventBus } from "../coordinator/event-bus.js";
import { t } from "../i18n/i18n.js";
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
    case "session":
      return `session ${event.sessionId}`;
    case "text":
      return event.text;
    case "tool":
      return `tool ${event.name} ${event.input}`;
    case "turn_started":
      return "working...";
    case "turn":
      return `turn ${event.result.status}`;
    case "rate_limit":
      return `usage ${[...usage("5h", event.fiveHour), ...usage("7d", event.weekly)].join(" / ")}`;
    case "compacted":
      return "compacted";
    case "subagents":
      return `subagents ${event.running.length}`;
    case "steer_delivered":
      return "steer delivered";
    case "context":
      return `context ${event.tokens} tokens${event.window ? ` / ${event.window}` : ""}`;
    case "exit":
      return `exited (code ${event.code})`;
    case "error":
      return `ERROR ${event.message}`;
  }
};

const indentContinuation = (text: string) => text.replace(/\r?\n/g, `\n${CONTINUATION_INDENT}`);

// 既定表示: 誰が何をしていて、誰が誰に何を頼んだかだけを出す（DESIGN.md §17）
const describeNormal = (event: AgentEvent): string | undefined => {
  switch (event.type) {
    case "turn_started":
      return t("log.working");
    case "error":
      return `ERROR ${event.message}`;
    case "turn": {
      const { status, text } = event.result;
      if (status === "completed") return text || t("log.done");
      return status === "interrupted" ? t("log.interrupted") : t("log.failed", { text });
    }
    default:
      return undefined;
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

// 既定表示では、ターンの最初の発言（方針）も出す。最終応答が方針と同じなら重ねて出さない（DESIGN.md §17）
export const createTerminalFormatter = () => {
  // Agent ごとの今のターンの方針。null はまだ発言していない
  const plans = new Map<string, string | null>();
  return (event: CoordinatorEvent, mode: DisplayMode): string | undefined => {
    if (mode === "verbose" || event.kind !== "agent") return formatEvent(event, mode);
    const { agent, event: agentEvent } = event;
    if (agentEvent.type === "turn_started") plans.set(agent, null);
    if (agentEvent.type === "text") {
      if (plans.get(agent) !== null) return undefined;
      plans.set(agent, agentEvent.text);
      return `${timeOf(event.at)} [${agent.toUpperCase()}] ${indentContinuation(agentEvent.text)}`;
    }
    if (agentEvent.type === "turn") {
      const plan = plans.get(agent);
      plans.delete(agent);
      const { status, text } = agentEvent.result;
      if (status === "completed" && plan && plan.trim() === text.trim()) return undefined;
    }
    return formatEvent(event, mode);
  };
};

export const createJsonlWriter = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  return (event: CoordinatorEvent): void => appendFileSync(path, `${JSON.stringify(event)}\n`);
};

// project の working tree を汚さないよう、ホームディレクトリに置く
// suffix: 会話ごとにファイルを分けるときの識別子（DESIGN.md §28 D1）
export const defaultLogPath = (homeDir: string, projectRoot: string, startedAt: Date, suffix?: string): string => {
  const d = startedAt;
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const name = basename(projectRoot) || projectRoot.replace(/[^A-Za-z0-9]/g, "-");
  return join(homeDir, LOG_DIR, `${name}-${stamp}${suffix ? `-${suffix}` : ""}${LOG_EXTENSION}`);
};

export interface EventLogOptions {
  path: string;
  print: (line: string) => void;
  mode: () => DisplayMode;
}

// file には常に全 event、terminal には表示モードに応じて出す
export const attachEventLog = (bus: EventBus, { path, print, mode }: EventLogOptions): (() => void) => {
  const write = createJsonlWriter(path);
  const format = createTerminalFormatter();
  return bus.subscribe(event => {
    write(event);
    const line = format(event, mode());
    if (line !== undefined) print(line);
  });
};
