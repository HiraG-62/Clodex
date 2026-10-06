// 1 行の人間の入力を Shell command に変換する（DESIGN.md §8）
import { t } from "../i18n/i18n.js";
import { AGENT_IDS, CLAUDE_EFFORT_LEVELS, COMMON_EFFORT_LEVELS, PERMISSION_LEVELS, isAgentId, type AgentId, type PermissionLevel } from "../agents/agent-adapter.js";

export type ShellCommand =
  | { kind: "empty" }
  | { kind: "send"; agent: AgentId; text: string; steer?: true }
  | { kind: "sendAll"; text: string; steer?: true }
  | { kind: "interrupt"; agent?: AgentId }
  | { kind: "status" }
  | { kind: "project"; path?: string }
  | { kind: "role"; agent?: AgentId; text?: string }
  | { kind: "help" }
  | { kind: "exit" }
  | { kind: "verbose" }
  | { kind: "permission"; level: PermissionLevel; agent?: AgentId }
  | { kind: "model"; agent: AgentId; model: string }
  | { kind: "effort"; agent?: AgentId; level: string }
  | { kind: "primary"; agent: AgentId }
  | { kind: "resume"; index?: number }
  | { kind: "new"; agent?: AgentId; worktree?: true }
  | { kind: "compact"; agent?: AgentId }
  | { kind: "cancel"; id?: string }
  | { kind: "rename"; title: string }
  | { kind: "delete"; index: number }
  | { kind: "pin"; index: number }
  | { kind: "run"; command: string }
  | { kind: "unsupported"; message: string }
  | { kind: "invalid"; message: string };

const MENTION_PATTERN = /^@(\S+)\s*([\s\S]*)$/;
const COMMAND_PATTERN = /^\/(\S+)\s*(.*)$/;

const isPermissionLevel = (value: string): value is PermissionLevel =>
  (PERMISSION_LEVELS as readonly string[]).includes(value);

const usage = (text: string): ShellCommand => ({ kind: "invalid", message: t("input.usage", { usage: text }) });
const unknownAgent = (agent: string): ShellCommand => ({ kind: "invalid", message: t("input.unknownAgent", { agent }) });
const PERMISSION_USAGE = `/permission [${AGENT_IDS.join("|")}] <${PERMISSION_LEVELS.join("|")}>`;
const MODEL_USAGE = `/model <${AGENT_IDS.join("|")}> <model>`;
const EFFORT_USAGE = `/effort [${AGENT_IDS.join("|")}] <level>`;

const parsePermission = (arg: string): ShellCommand => {
  const [first, second, ...extra] = arg.split(/\s+/).filter(Boolean);
  if (!first || extra.length) return usage(PERMISSION_USAGE);
  if (!second) return isPermissionLevel(first)
    ? { kind: "permission", level: first } : usage(PERMISSION_USAGE);
  if (!isPermissionLevel(second)) return usage(PERMISSION_USAGE);
  return isAgentId(first) ? { kind: "permission", agent: first, level: second } : unknownAgent(first);
};

const parseModel = (arg: string): ShellCommand => {
  const [agent, model, ...extra] = arg.split(/\s+/).filter(Boolean);
  if (!agent || !model || extra.length) return usage(MODEL_USAGE);
  return isAgentId(agent) ? { kind: "model", agent, model } : unknownAgent(agent);
};

const parseEffort = (arg: string): ShellCommand => {
  const [first, second, ...extra] = arg.split(/\s+/).filter(Boolean);
  if (!first || extra.length) return usage(EFFORT_USAGE);
  if (!second) {
    return (COMMON_EFFORT_LEVELS as readonly string[]).includes(first)
      ? { kind: "effort", level: first } : usage(EFFORT_USAGE);
  }
  if (!isAgentId(first)) return unknownAgent(first);
  if (first === "claude" && !(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(second)) {
    return usage(EFFORT_USAGE);
  }
  return { kind: "effort", agent: first, level: second };
};

// /resume の一覧の番号（1 始まり）
const NEW_WORKTREE_ARG = "worktree";

const isConversationNumber = (arg: string) => /^[1-9]\d*$/.test(arg);

const unsupported = (feature: string): ShellCommand =>
  ({ kind: "unsupported", message: t("input.unsupported", { feature }) });

// 行頭の @agent は送り先。Agent でなければ undefined（ファイルの参照として本文に残す）
// @agent! は実行中のターンへの割り込み（DESIGN.md §28 v0.3 C）
const STEER_SUFFIX = "!";

const parseMention = (mention: string, text: string): ShellCommand | undefined => {
  const steer = mention.endsWith(STEER_SUFFIX);
  const name = steer ? mention.slice(0, -STEER_SUFFIX.length) : mention;
  if (name === "all") {
    if (!text) return { kind: "invalid", message: t("input.empty", { agent: name }) };
    return steer ? { kind: "sendAll", text, steer: true } : { kind: "sendAll", text };
  }
  if (!isAgentId(name)) return undefined;
  if (!text) return { kind: "invalid", message: t("input.empty", { agent: name }) };
  return steer ? { kind: "send", agent: name, text, steer: true } : { kind: "send", agent: name, text };
};

const parseCommand = (name: string, arg: string): ShellCommand => {
  switch (name) {
    case "role": {
      if (!arg) return { kind: "role" };
      const [agent, ...words] = arg.split(/\s+/);
      if (!agent) return { kind: "role" };
      if (!isAgentId(agent)) return unknownAgent(agent);
      return words.length ? { kind: "role", agent, text: words.join(" ") } : { kind: "role", agent };
    }
    case "project":
      return arg ? { kind: "project", path: arg } : { kind: "project" };
    case "interrupt":
      if (!arg) return { kind: "interrupt" };
      return isAgentId(arg) ? { kind: "interrupt", agent: arg } : unknownAgent(arg);
    case "permission":
      return parsePermission(arg);
    case "model":
      return parseModel(arg);
    case "effort":
      return parseEffort(arg);
    case "new":
      // /new worktree: 新しい会話を worktree で始める（DESIGN.md §28 D1）
      if (arg === NEW_WORKTREE_ARG) return { kind: "new", worktree: true };
      if (!arg) return { kind: name };
      return isAgentId(arg) ? { kind: name, agent: arg } : unknownAgent(arg);
    case "compact":
      if (!arg) return { kind: name };
      return isAgentId(arg) ? { kind: name, agent: arg } : unknownAgent(arg);
    case "cancel":
      if (!arg) return { kind: "cancel" };
      return /^\S+$/.test(arg) ? { kind: "cancel", id: arg } : usage("/cancel [id]");
    case "resume":
      if (!arg) return { kind: "resume" };
      return isConversationNumber(arg) ? { kind: "resume", index: Number(arg) } : usage("/resume [number]");
    case "rename":
      return arg ? { kind: "rename", title: arg } : usage("/rename <title>");
    case "delete":
    case "pin":
      return isConversationNumber(arg) ? { kind: name, index: Number(arg) } : usage(`/${name} <number>`);
    case "primary":
      if (!arg) return usage(`/primary <${AGENT_IDS.join("|")}>`);
      return isAgentId(arg) ? { kind: "primary", agent: arg } : unknownAgent(arg);
    case "status":
    case "help":
    case "exit":
    case "verbose":
      return { kind: name };
    default:
      return { kind: "invalid", message: t("input.unknownCommand", { name }) };
  }
};

export const parseInput = (line: string, primary: AgentId): ShellCommand => {
  const input = line.trim();
  if (!input) return { kind: "empty" };
  if (input.startsWith("/") && /[\r\n]/.test(line)) return { kind: "invalid", message: t("input.oneLine") };
  if (input.startsWith("!&")) return unsupported("!& command");
  if (input.startsWith("!")) {
    const command = input.slice(1).trim();
    return command ? { kind: "run", command } : usage("!<command>");
  }

  const mention = input.match(MENTION_PATTERN);
  const mentioned = mention?.[1] !== undefined && mention[2] !== undefined ? parseMention(mention[1], mention[2].trim()) : undefined;
  if (mentioned) return mentioned;

  const command = input.match(COMMAND_PATTERN);
  if (command?.[1] !== undefined && command[2] !== undefined) return parseCommand(command[1], command[2].trim());

  return { kind: "send", agent: primary, text: input };
};
