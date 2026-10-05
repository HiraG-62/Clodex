// 人間の入力を Coordinator の操作に変換する（DESIGN.md §8）。readline 等の I/O は index.ts が持つ
import type { AgentId, AgentStatus, PermissionLevel, TurnResult } from "../agents/agent-adapter.js";
import type { UsageSnapshot } from "../coordinator/usage-monitor.js";
import type { Conversation, SavedSessions } from "../project/conversation-history.js";
import { parseInput } from "./input.js";

export interface AgentState {
  id: AgentId;
  status: AgentStatus;
  sessionId: string | undefined;
  permission: PermissionLevel;
  usage: UsageSnapshot;
}

export interface ShellCoordinator {
  sendToAgent(agent: AgentId, text: string): Promise<TurnResult>;
  interrupt(agent?: AgentId): Promise<void>;
  setPermission(level: PermissionLevel, agent?: AgentId): Promise<void>;
  switchSessions(sessions: SavedSessions, targets?: readonly AgentId[]): Promise<string | undefined>;
  status(): AgentState[];
}

export interface ConversationList {
  readonly currentId: string;
  list(): Conversation[];
  switchTo(id: string): Conversation | undefined;
  startNew(): void;
  clearSession(agent: AgentId): void;
}

export interface ShellOptions {
  coordinator: ShellCoordinator;
  primary: AgentId;
  print: (line: string) => void;
  // terminal の詳細表示を切り替え、切り替え後の状態を返す
  toggleVerbose: () => boolean;
  history: ConversationList;
}

export type ShellOutcome = "continue" | "exit";

const HELP_LINES = (primary: AgentId) => [
  `<text>              send to the primary agent (${primary})`,
  "@claude <text>      send to Claude",
  "@codex <text>       send to Codex",
  "/interrupt [agent]  interrupt the running turn (all agents if omitted)",
  "/status             show agent status and usage",
  "/primary <agent>    change where plain text goes",
  "/resume [number]    list past conversations, or switch to one",
  "/new [agent]        start fresh sessions (a new conversation if agent is omitted)",
  "/verbose            toggle detailed output (tools, usage, intermediate text)",
  "/permission [agent] <read-only|edit|full>  change what agents may do without asking",
  "/exit               stop all agents and quit",
  "Ctrl+C              interrupt running turns",
];

const formatUsage = ({ fiveHourPercent, weeklyPercent, weeklyPace }: UsageSnapshot): string => {
  const parts = [
    ...(fiveHourPercent === undefined ? [] : [`5h ${fiveHourPercent}%`]),
    ...(weeklyPercent === undefined ? [] : [`7d ${weeklyPercent}% (pace ${weeklyPace! > 0 ? "+" : ""}${weeklyPace})`]),
  ];
  return `  usage: ${parts.length ? parts.join(", ") : "unknown"}`;
};

const TOKENS_PER_K = 1000;
const PERCENT = 100;
const kTokens = (n: number) => `${Math.round(n / TOKENS_PER_K)}k`;

const formatContext = ({ contextTokens, contextWindow }: UsageSnapshot): string => {
  if (contextTokens === undefined) return "  context: unknown";
  if (!contextWindow) return `  context: ${kTokens(contextTokens)} tokens`;
  const percent = Math.round((contextTokens / contextWindow) * PERCENT);
  return `  context: ${kTokens(contextTokens)} / ${kTokens(contextWindow)} tokens (${percent}%)`;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const shortTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const agentsOf = (c: Conversation) => (Object.keys(c.sessions) as AgentId[]).sort().join(", ");
const titleOf = (c: Conversation) => `"${c.title ?? "(no input)"}"`;

export const createShell = ({ coordinator, primary: initialPrimary, print, toggleVerbose, history }: ShellOptions) => {
  let primary = initialPrimary;

  const listConversations = () => {
    history.list().forEach((c, i) => {
      const current = c.id === history.currentId ? "  (current)" : "";
      print(`${i + 1}) ${shortTime(c.updatedAt)}  ${agentsOf(c)}  ${titleOf(c)}${current}`);
    });
    print("Type /resume <number> to switch.");
  };

  const startFresh = async (agent: AgentId | undefined) => {
    const error = await coordinator.switchSessions({}, agent ? [agent] : undefined);
    if (error) return print(error);
    if (agent) {
      history.clearSession(agent);
      return print(`${agent} starts a new session on next use`);
    }
    history.startNew();
    print("new conversation (agents start fresh on next use)");
  };

  const resumeConversation = async (index: number) => {
    const picked = history.list()[index - 1];
    if (!picked) return print(`no conversation #${index} (see /resume)`);
    if (picked.id === history.currentId) return print("already in this conversation");
    const error = await coordinator.switchSessions(picked.sessions);
    if (error) return print(error);
    history.switchTo(picked.id);
    print(`resumed: ${titleOf(picked)} (${agentsOf(picked)} resume on next use)`);
  };

  const handleLine = async (line: string): Promise<ShellOutcome> => {
    const command = parseInput(line, primary);
    switch (command.kind) {
      case "empty":
        return "continue";
      case "send":
        // 送信はキューに積むだけ。ターン完了は Event Bus 経由で表示される
        void coordinator.sendToAgent(command.agent, command.text);
        return "continue";
      case "interrupt":
        await coordinator.interrupt(command.agent);
        return "continue";
      case "status":
        print(`primary: ${primary}`);
        for (const { id, status, sessionId, permission, usage } of coordinator.status()) {
          print(`${id}: ${status}, permission ${permission}${sessionId ? ` (session ${sessionId})` : ""}`);
          print(formatUsage(usage));
          print(formatContext(usage));
        }
        return "continue";
      case "new":
        await startFresh(command.agent);
        return "continue";
      case "resume":
        if (command.index === undefined) listConversations();
        else await resumeConversation(command.index);
        return "continue";
      case "primary":
        primary = command.agent;
        print(`primary: ${primary}`);
        return "continue";
      case "help":
        HELP_LINES(primary).forEach((l) => print(l));
        return "continue";
      case "permission":
        await coordinator.setPermission(command.level, command.agent);
        print(`permission: ${command.agent ?? "all agents"} -> ${command.level}`);
        return "continue";
      case "verbose":
        print(`verbose: ${toggleVerbose() ? "on" : "off"}`);
        return "continue";
      case "exit":
        return "exit";
      case "unsupported":
      case "invalid":
        print(command.message);
        return "continue";
    }
  };

  const handleSigint = async (): Promise<void> => {
    const busy = coordinator.status().filter((s) => s.status === "busy");
    if (busy.length === 0) {
      print("No running turn. Type /exit to quit.");
      return;
    }
    await Promise.all(busy.map(({ id }) => coordinator.interrupt(id)));
  };

  return { handleLine, handleSigint };
};
