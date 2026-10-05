// 1 行の人間の入力を Shell command に変換する（DESIGN.md §8）
import { AGENT_IDS, CLAUDE_EFFORT_LEVELS, COMMON_EFFORT_LEVELS, PERMISSION_LEVELS, isAgentId, type AgentId, type PermissionLevel } from "../agents/agent-adapter.js";

export type ShellCommand =
  | { kind: "empty" }
  | { kind: "send"; agent: AgentId; text: string }
  | { kind: "interrupt"; agent?: AgentId }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "exit" }
  | { kind: "verbose" }
  | { kind: "permission"; level: PermissionLevel; agent?: AgentId }
  | { kind: "model"; agent: AgentId; model: string }
  | { kind: "effort"; agent?: AgentId; level: string }
  | { kind: "primary"; agent: AgentId }
  | { kind: "resume"; index?: number }
  | { kind: "new"; agent?: AgentId }
  | { kind: "compact"; agent?: AgentId }
  | { kind: "cancel"; id?: string }
  | { kind: "run"; command: string }
  | { kind: "unsupported"; message: string }
  | { kind: "invalid"; message: string };

const MENTION_PATTERN = /^@(\S+)\s*([\s\S]*)$/;
const COMMAND_PATTERN = /^\/(\S+)\s*(.*)$/;

const isPermissionLevel = (value: string): value is PermissionLevel =>
  (PERMISSION_LEVELS as readonly string[]).includes(value);

const PERMISSION_USAGE = `usage: /permission [${AGENT_IDS.join("|")}] <${PERMISSION_LEVELS.join("|")}>`;
const MODEL_USAGE = `usage: /model <${AGENT_IDS.join("|")}> <model>`;
const EFFORT_USAGE = `usage: /effort [${AGENT_IDS.join("|")}] <level>`;

const parsePermission = (arg: string): ShellCommand => {
  const [first, second, ...extra] = arg.split(/\s+/).filter(Boolean);
  if (!first || extra.length) return { kind: "invalid", message: PERMISSION_USAGE };
  if (!second) return isPermissionLevel(first)
    ? { kind: "permission", level: first } : { kind: "invalid", message: PERMISSION_USAGE };
  if (!isPermissionLevel(second)) return { kind: "invalid", message: PERMISSION_USAGE };
  return isAgentId(first) ? { kind: "permission", agent: first, level: second } : { kind: "invalid", message: `unknown agent: ${first}` };
};

const parseModel = (arg: string): ShellCommand => {
  const [agent, model, ...extra] = arg.split(/\s+/).filter(Boolean);
  if (!agent || !model || extra.length) return { kind: "invalid", message: MODEL_USAGE };
  return isAgentId(agent) ? { kind: "model", agent, model } : { kind: "invalid", message: `unknown agent: ${agent}` };
};

const parseEffort = (arg: string): ShellCommand => {
  const [first, second, ...extra] = arg.split(/\s+/).filter(Boolean);
  if (!first || extra.length) return { kind: "invalid", message: EFFORT_USAGE };
  if (!second) {
    return (COMMON_EFFORT_LEVELS as readonly string[]).includes(first)
      ? { kind: "effort", level: first } : { kind: "invalid", message: EFFORT_USAGE };
  }
  if (!isAgentId(first)) return { kind: "invalid", message: `unknown agent: ${first}` };
  if (first === "claude" && !(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(second)) {
    return { kind: "invalid", message: EFFORT_USAGE };
  }
  return { kind: "effort", agent: first, level: second };
};

const unsupported = (feature: string): ShellCommand =>
  ({ kind: "unsupported", message: `${feature} is not supported in v0.1` });

// 行頭の @agent は送り先。Agent でなければ undefined（ファイルの参照として本文に残す）
const parseMention = (name: string, text: string): ShellCommand | undefined => {
  if (name === "all") return unsupported("@all");
  if (!isAgentId(name)) return undefined;
  if (!text) return { kind: "invalid", message: `empty message for @${name}` };
  return { kind: "send", agent: name, text };
};

const parseCommand = (name: string, arg: string): ShellCommand => {
  switch (name) {
    case "interrupt":
      if (!arg) return { kind: "interrupt" };
      return isAgentId(arg) ? { kind: "interrupt", agent: arg } : { kind: "invalid", message: `unknown agent: ${arg}` };
    case "permission":
      return parsePermission(arg);
    case "model":
      return parseModel(arg);
    case "effort":
      return parseEffort(arg);
    case "new":
    case "compact":
      if (!arg) return { kind: name };
      return isAgentId(arg) ? { kind: name, agent: arg } : { kind: "invalid", message: `unknown agent: ${arg}` };
    case "cancel":
      if (!arg) return { kind: "cancel" };
      return /^\S+$/.test(arg) ? { kind: "cancel", id: arg } : { kind: "invalid", message: "usage: /cancel [id]" };
    case "resume":
      if (!arg) return { kind: "resume" };
      return /^[1-9]\d*$/.test(arg) ? { kind: "resume", index: Number(arg) } : { kind: "invalid", message: "usage: /resume [number]" };
    case "primary":
      if (!arg) return { kind: "invalid", message: `usage: /primary <${AGENT_IDS.join("|")}>` };
      return isAgentId(arg) ? { kind: "primary", agent: arg } : { kind: "invalid", message: `unknown agent: ${arg}` };
    case "status":
    case "help":
    case "exit":
    case "verbose":
      return { kind: name };
    default:
      return { kind: "invalid", message: `unknown command: /${name} (see /help)` };
  }
};

export const parseInput = (line: string, primary: AgentId): ShellCommand => {
  const input = line.trim();
  if (!input) return { kind: "empty" };
  if (input.startsWith("/") && /[\r\n]/.test(line)) return { kind: "invalid", message: "slash commands must be one line" };
  if (input.startsWith("!&")) return unsupported("!& command");
  if (input.startsWith("!")) {
    const command = input.slice(1).trim();
    return command ? { kind: "run", command } : { kind: "invalid", message: "usage: !<command>" };
  }

  const mention = input.match(MENTION_PATTERN);
  const mentioned = mention?.[1] !== undefined && mention[2] !== undefined ? parseMention(mention[1], mention[2].trim()) : undefined;
  if (mentioned) return mentioned;

  const command = input.match(COMMAND_PATTERN);
  if (command?.[1] !== undefined && command[2] !== undefined) return parseCommand(command[1], command[2].trim());

  return { kind: "send", agent: primary, text: input };
};
