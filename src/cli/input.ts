// 1 行の人間の入力を Shell command に変換する（DESIGN.md §8）
import { LIMIT_NAMES, isLimitValue, type LimitName } from "../coordinator/budget-manager.js";
import { t } from "../i18n/i18n.js";
import { AGENT_IDS, CLAUDE_EFFORT_LEVELS, COMMON_EFFORT_LEVELS, PERMISSION_LEVELS, isAgentId, type AgentId, type PermissionLevel } from "../agents/agent-adapter.js";
import type { SoloMode } from "../coordinator/coordinator.js";

import { LANGUAGES, type Language } from "../context/language.js";

export type ShellCommand =
  | { kind: "language"; value?: Language }
  | { kind: "sandbox"; action?: "on" | "off" | "uninstall" }
  | { kind: "limits"; values?: Array<{ name: LimitName; value: number }>; reset?: true; unlimited?: true }
  | { kind: "empty" }
  | { kind: "send"; agent: AgentId; text: string; steer?: true; context?: true }
  | { kind: "sendAll"; text: string; steer?: true; context?: true }
  | { kind: "interrupt"; agent?: AgentId }
  | { kind: "status" }
  | { kind: "project"; path?: string; action?: ProjectAction }
  | { kind: "tab"; conversationId: string; projectRoot: string; action?: "unpin" }
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
  | { kind: "answer"; id: string; text: string }
  | { kind: "cancel"; id?: string }
  | { kind: "rename"; title: string; index?: number }
  | { kind: "solo"; mode?: SoloMode }
  | { kind: "delete"; index: number }
  | { kind: "pin"; index: number }
  | { kind: "run"; command: string }
  | { kind: "runAndSend"; command: string; agent?: AgentId }
  | { kind: "background"; command: string }
  | { kind: "processes"; id?: number }
  | { kind: "kill"; id: number }
  | { kind: "invalid"; message: string };

const MENTION_PATTERN = /^@(\S+)\s*([\s\S]*)$/;
const COMMAND_PATTERN = /^\/(\S+)\s*(.*)$/;

const isPermissionLevel = (value: string): value is PermissionLevel =>
  (PERMISSION_LEVELS as readonly string[]).includes(value);

// /project pin|remove <path>: 一覧の整理（DESIGN.md §28 D2a）
export type ProjectAction = "pin" | "remove";
const PROJECT_ACTION_PATTERN = /^(pin|remove)(?:\s+(.*))?$/;

const usage = (text: string): ShellCommand => ({ kind: "invalid", message: t("input.usage", { usage: text }) });
const unknownAgent = (agent: string): ShellCommand => ({ kind: "invalid", message: t("input.unknownAgent", { agent }) });
const PERMISSION_USAGE = `/permission [${AGENT_IDS.join("|")}] <${PERMISSION_LEVELS.join("|")}>`;
const MODEL_USAGE = `/model <${AGENT_IDS.join("|")}> <model>`;
const EFFORT_USAGE = `/effort [${AGENT_IDS.join("|")}] <level>`;
const LIMITS_USAGE = "/limits [<name> <n> ...|reset|unlimited]";

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

// 行頭の @agent は送り先。Agent でなければ undefined（ファイルの参照として本文に残す）
// @agent! は実行中のターンへの割り込み（DESIGN.md §28 v0.3 C）
const STEER_SUFFIX = "!";
const CONTEXT_COMMAND = "/context";
const CONTEXT_USAGE = "/context <text>";

const contextText = (text: string): string | undefined =>
  text === CONTEXT_COMMAND ? "" : text.startsWith(`${CONTEXT_COMMAND} `) ? text.slice(CONTEXT_COMMAND.length).trim() : undefined;

const RUN_AND_SEND_PREFIX = "!>";

const parseRunAndSend = (input: string, agent?: AgentId): ShellCommand => {
  const command = input.slice(RUN_AND_SEND_PREFIX.length).trim();
  if (!command) return usage("!> <command>");
  return agent ? { kind: "runAndSend", command, agent } : { kind: "runAndSend", command };
};

const parseMention = (mention: string, text: string): ShellCommand | undefined => {
  const steer = mention.endsWith(STEER_SUFFIX);
  const name = steer ? mention.slice(0, -STEER_SUFFIX.length) : mention;
  const request = contextText(text);
  if (request !== undefined && !request && (name === "all" || isAgentId(name))) return usage(CONTEXT_USAGE);
  const body = request ?? text;
  const context = request === undefined ? {} : { context: true as const };
  if (name === "all") {
    if (!text) return { kind: "invalid", message: t("input.empty", { agent: name }) };
    return steer ? { kind: "sendAll", text: body, steer: true, ...context } : { kind: "sendAll", text: body, ...context };
  }
  if (!isAgentId(name)) return undefined;
  if (!steer && text.startsWith(RUN_AND_SEND_PREFIX)) return parseRunAndSend(text, name);
  if (!text) return { kind: "invalid", message: t("input.empty", { agent: name }) };
  return steer ? { kind: "send", agent: name, text: body, steer: true, ...context } : { kind: "send", agent: name, text: body, ...context };
};

const parseCommand = (name: string, arg: string, primary: AgentId): ShellCommand => {
  switch (name) {
    case "context":
      return arg ? { kind: "send", agent: primary, text: arg, context: true } : usage(CONTEXT_USAGE);
    case "language":
      if (!arg) return { kind: "language" };
      return (LANGUAGES as readonly string[]).includes(arg) ? { kind: "language", value: arg as Language } : usage("/language [ja|en]");
    case "sandbox":
      if (!arg) return { kind: "sandbox" };
      return arg === "on" || arg === "off" || arg === "uninstall" ? { kind: "sandbox", action: arg } : usage("/sandbox [on|off|uninstall]");
    case "limits": {
      if (!arg) return { kind: "limits" };
      if (arg === "reset") return { kind: "limits", reset: true };
      if (arg === "unlimited") return { kind: "limits", unlimited: true };
      const parts = arg.split(/\s+/);
      if (parts.length % 2 !== 0) return usage(LIMITS_USAGE);
      const values: Array<{ name: LimitName; value: number }> = [];
      const seen = new Set<LimitName>();
      for (let index = 0; index < parts.length; index += 2) {
        const name = parts[index];
        const raw = parts[index + 1];
        const value = Number(raw);
        if (!name || !raw || !LIMIT_NAMES.includes(name as LimitName) || seen.has(name as LimitName) || !/^\d+$/.test(raw) || !isLimitValue(value)) return usage(LIMITS_USAGE);
        seen.add(name as LimitName);
        values.push({ name: name as LimitName, value });
      }
      return { kind: "limits", values };
    }
    case "answer": {
      const match = /^(\S+)\s+(.+)$/.exec(arg);
      return match?.[1] && match[2] ? { kind: "answer", id: match[1], text: match[2] } : usage("/answer <id> <json>");
    }
    case "processes":
      if (!arg) return { kind: "processes" };
      return isConversationNumber(arg) && Number.isSafeInteger(Number(arg)) ? { kind: "processes", id: Number(arg) } : usage("/processes [number]");
    case "kill":
      return isConversationNumber(arg) && Number.isSafeInteger(Number(arg)) ? { kind: "kill", id: Number(arg) } : usage("/kill <number>");
    case "role": {
      if (!arg) return { kind: "role" };
      const [agent, ...words] = arg.split(/\s+/);
      if (!agent) return { kind: "role" };
      if (!isAgentId(agent)) return unknownAgent(agent);
      return words.length ? { kind: "role", agent, text: words.join(" ") } : { kind: "role", agent };
    }
    case "project": {
      if (!arg) return { kind: "project" };
      const action = PROJECT_ACTION_PATTERN.exec(arg);
      if (!action) return { kind: "project", path: arg };
      const path = action[2]?.trim();
      return path ? { kind: "project", action: action[1] as ProjectAction, path } : usage("/project pin|remove <path>");
    }
    case "tab": {
      const tabUsage = "/tab [unpin] <id> <project root>";
      const unpin = arg === "unpin" || arg.startsWith("unpin ");
      const rest = unpin ? arg.slice("unpin".length).trim() : arg;
      const match = rest.match(/^(\S+)\s+(.+)$/);
      return match?.[1] && match[2]
        ? { kind: "tab", ...(unpin ? { action: "unpin" as const } : {}), conversationId: match[1], projectRoot: match[2] }
        : usage(tabUsage);
    }
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
    case "rename": {
      const renameUsage = "/rename [#<number>] <title>";
      if (!arg) return usage(renameUsage);
      if (!arg.startsWith("#")) return { kind: "rename", title: arg };
      const match = arg.match(/^#([1-9]\d*)\s+(.+)$/);
      return match?.[1] && match[2]
        ? { kind: "rename", index: Number(match[1]), title: match[2] }
        : usage(renameUsage);
    }
    case "solo":
      if (!arg || arg === "enable") return { kind: "solo", mode: "free" };
      if (arg === "disable") return { kind: "solo" };
      return isAgentId(arg) ? { kind: "solo", mode: arg } : usage("/solo [enable|disable|claude|codex]");
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
  if (input.startsWith(RUN_AND_SEND_PREFIX)) return parseRunAndSend(input);
  if (input.startsWith("!&")) {
    const command = input.slice(2).trim();
    return command ? { kind: "background", command } : usage("!& <command>");
  }
  if (input.startsWith("!")) {
    const command = input.slice(1).trim();
    return command ? { kind: "run", command } : usage("!<command>");
  }

  const mention = input.match(MENTION_PATTERN);
  const mentioned = mention?.[1] !== undefined && mention[2] !== undefined ? parseMention(mention[1], mention[2].trim()) : undefined;
  if (mentioned) return mentioned;

  const command = input.match(COMMAND_PATTERN);
  if (command?.[1] !== undefined && command[2] !== undefined) return parseCommand(command[1], command[2].trim(), primary);

  return { kind: "send", agent: primary, text: input };
};
