// 1 行の人間の入力を Shell command に変換する（DESIGN.md §8）
import { AGENT_IDS, PERMISSION_LEVELS, type AgentId, type PermissionLevel } from "../agents/agent-adapter.js";

export type ShellCommand =
  | { kind: "empty" }
  | { kind: "send"; agent: AgentId; text: string }
  | { kind: "interrupt"; agent?: AgentId }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "exit" }
  | { kind: "verbose" }
  | { kind: "permission"; level: PermissionLevel; agent?: AgentId }
  | { kind: "unsupported"; message: string }
  | { kind: "invalid"; message: string };

const MENTION_PATTERN = /^@(\S+)\s*([\s\S]*)$/;
const COMMAND_PATTERN = /^\/(\S+)\s*(.*)$/;

const isAgentId = (value: string): value is AgentId => (AGENT_IDS as readonly string[]).includes(value);
const isPermissionLevel = (value: string): value is PermissionLevel =>
  (PERMISSION_LEVELS as readonly string[]).includes(value);

const PERMISSION_USAGE = `usage: /permission [${AGENT_IDS.join("|")}] <${PERMISSION_LEVELS.join("|")}>`;

const parsePermission = (arg: string): ShellCommand => {
  const parts = arg.split(/\s+/).filter(Boolean);
  const level = parts.at(-1);
  if (parts.length === 0 || parts.length > 2 || !level || !isPermissionLevel(level)) {
    return { kind: "invalid", message: PERMISSION_USAGE };
  }
  if (parts.length === 1) return { kind: "permission", level };
  const agent = parts[0]!;
  return isAgentId(agent) ? { kind: "permission", agent, level } : { kind: "invalid", message: `unknown agent: ${agent}` };
};

const unsupported = (feature: string): ShellCommand =>
  ({ kind: "unsupported", message: `${feature} is not supported in v0.1` });

const parseMention = (name: string, text: string): ShellCommand => {
  if (name === "all") return unsupported("@all");
  if (!isAgentId(name)) return { kind: "invalid", message: `unknown agent: @${name}` };
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
  if (input.startsWith("!&")) return unsupported("!& command");
  if (input.startsWith("!")) return unsupported("!command");

  const mention = input.match(MENTION_PATTERN);
  if (mention) return parseMention(mention[1]!, mention[2]!.trim());

  const command = input.match(COMMAND_PATTERN);
  if (command) return parseCommand(command[1]!, command[2]!.trim());

  return { kind: "send", agent: primary, text: input };
};
