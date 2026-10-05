// 人間の入力を Coordinator の操作に変換する（DESIGN.md §8）。readline 等の I/O は index.ts が持つ
import { AGENT_IDS, type AgentId, type AgentStatus, type PermissionLevel, type TurnResult } from "../agents/agent-adapter.js";
import type { UsageSnapshot } from "../coordinator/usage-monitor.js";
import type { Conversation, SavedSessions } from "../project/conversation-history.js";
import { SLASH_COMMANDS, commandUsage } from "./commands.js";
import { appendFileReferences } from "./file-references.js";
import { parseInput } from "./input.js";

export interface AgentState {
  id: AgentId;
  status: AgentStatus;
  sessionId: string | undefined;
  permission: PermissionLevel;
  model?: string;
  effort?: string;
  usage: UsageSnapshot;
}

export interface ShellCoordinator {
  sendToAgent(agent: AgentId, text: string): Promise<TurnResult>;
  interrupt(agent?: AgentId): Promise<void>;
  compact(agent?: AgentId): Promise<unknown>;
  setPermission(level: PermissionLevel, agent?: AgentId): Promise<void>;
  setModel(model: string, agent: AgentId): Promise<TurnResult | void>;
  setEffort(level: string, agent?: AgentId): Promise<TurnResult | void>;
  switchSessions(sessions: SavedSessions, targets?: readonly AgentId[]): Promise<string | undefined>;
  pendingInputs(): PendingInput[];
  cancelInput(id?: string): PendingInput | undefined;
  status(): AgentState[];
}

export interface PendingInput {
  id: string;
  agent: AgentId;
  text: string;
}

export interface ConversationList {
  readonly currentId: string;
  list(): Conversation[];
  switchTo(id: string): Conversation | undefined;
  startNew(): void;
  clearSession(agent: AgentId): void;
  rename(title: string): void;
  // 削除できなければ理由を返す
  remove(id: string): string | undefined;
  // 切り替え後のピン止めの状態。無い会話なら undefined
  togglePin(id: string): boolean | undefined;
}

export interface CommandRunner {
  readonly running: number;
  run(command: string): Promise<void>;
  // 実行中の command を止め、止めた数を返す
  stopAll(): number;
}

export interface ShellOptions {
  coordinator: ShellCoordinator;
  primary: AgentId;
  print: (line: string) => void;
  // terminal の詳細表示を切り替え、切り替え後の状態を返す
  toggleVerbose: () => boolean;
  history: ConversationList;
  runner: CommandRunner;
  // 人が切り替えた設定を保存する（DESIGN.md §9 Agent の設定の保存）
  saveSettings?: (agents: readonly AgentId[], change: SettingsChange) => void;
  // @path の参照先が project のファイルか（DESIGN.md §28 v0.3 A）
  isProjectFile?: (path: string) => boolean;
}

export interface SettingsChange {
  permission?: PermissionLevel;
  model?: string;
  effort?: string;
}

export type ShellOutcome = "continue" | "exit";

// 説明の開始位置をそろえる幅
const HELP_COLUMN = 20;
const helpLine = (usage: string, description: string) => `${usage.padEnd(HELP_COLUMN - 1)} ${description}`;

const HELP_LINES = (primary: AgentId) => [
  helpLine("<text>", `send to the primary agent (${primary})`),
  helpLine("@claude <text>", "send to Claude"),
  helpLine("@codex <text>", "send to Codex"),
  helpLine("!<command>", "run a shell command in the project root (output is not sent to agents)"),
  ...SLASH_COMMANDS.map((command) => helpLine(commandUsage(command), command.description)),
  helpLine("Ctrl+C", "interrupt running turns and !commands"),
];

const MS_PER_SECOND = 1000;
const pad2 = (n: number) => String(n).padStart(2, "0");
const clockTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const shortTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${clockTime(iso)}`;
};

const formatUsage = ({ fiveHourPercent, fiveHourResetsAt, weeklyPercent, weeklyPace, weeklyResetsAt }: UsageSnapshot): string => {
  const resets = (epochSeconds: number | undefined, format: (iso: string) => string) =>
    epochSeconds === undefined ? "" : `resets ${format(new Date(epochSeconds * MS_PER_SECOND).toISOString())}`;
  const fiveHourReset = resets(fiveHourResetsAt, clockTime);
  const weeklyReset = resets(weeklyResetsAt, shortTime);
  const pace = `pace ${weeklyPace! > 0 ? "+" : ""}${weeklyPace}`;
  const parts = [
    ...(fiveHourPercent === undefined ? [] : [`5h ${fiveHourPercent}%${fiveHourReset ? ` (${fiveHourReset})` : ""}`]),
    ...(weeklyPercent === undefined ? [] : [`7d ${weeklyPercent}% (${[pace, weeklyReset].filter(Boolean).join(", ")})`]),
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


const agentsOf = (c: Conversation) => (Object.keys(c.sessions) as AgentId[]).sort().join(", ");
const titleOf = (c: Conversation) => `"${c.title ?? "(no input)"}"`;

export const createShell = ({
  coordinator, primary: initialPrimary, print, toggleVerbose, history, runner, saveSettings = () => {}, isProjectFile = () => false,
}: ShellOptions) => {
  let primary = initialPrimary;
  const targets = (agent: AgentId | undefined): readonly AgentId[] => (agent ? [agent] : AGENT_IDS);

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
    const picked = pickConversation(index);
    if (!picked) return;
    if (picked.id === history.currentId) return print("already in this conversation");
    const error = await coordinator.switchSessions(picked.sessions);
    if (error) return print(error);
    history.switchTo(picked.id);
    print(`resumed: ${titleOf(picked)} (${agentsOf(picked)} resume on next use)`);
  };

  const pickConversation = (index: number) => {
    const picked = history.list()[index - 1];
    if (!picked) print(`no conversation #${index} (see /resume)`);
    return picked;
  };

  const handleLine = async (line: string): Promise<ShellOutcome> => {
    const command = parseInput(line, primary);
    switch (command.kind) {
      case "empty":
        return "continue";
      case "send":
        // 送信はキューに積むだけ。ターン完了は Event Bus 経由で表示される
        void coordinator.sendToAgent(command.agent, appendFileReferences(command.text, isProjectFile));
        return "continue";
      case "interrupt":
        if (!command.agent) runner.stopAll();
        await coordinator.interrupt(command.agent);
        return "continue";
      case "run":
        // 終了を待たずに次の入力を受け付ける。出力は runner が表示する
        void runner.run(command.command);
        return "continue";
      case "status":
        print(`primary: ${primary}`);
        for (const { id, status, sessionId, permission, model, effort, usage } of coordinator.status()) {
          print(`${id}: ${status}, permission ${permission}, model ${model ?? "default"}, effort ${effort ?? "default"}${sessionId ? ` (session ${sessionId})` : ""}`);
          print(formatUsage(usage));
          print(formatContext(usage));
        }
        for (const input of coordinator.pendingInputs()) print(`queued: ${input.id} -> ${input.agent}: ${input.text}`);
        return "continue";
      case "cancel": {
        const canceled = coordinator.cancelInput(command.id);
        print(canceled ? `canceled: ${canceled.id} -> ${canceled.agent}` : `nothing to cancel${command.id ? `: ${command.id}` : ""} (already delivered?)`);
        return "continue";
      }
      case "new":
        await startFresh(command.agent);
        return "continue";
      case "compact":
        // 1 ターンとしてキューに積むだけ。進み具合は Event Bus 経由で表示される
        void coordinator.compact(command.agent);
        print(`compact queued: ${command.agent ?? "running agents"}`);
        return "continue";
      case "resume":
        if (command.index === undefined) listConversations();
        else await resumeConversation(command.index);
        return "continue";
      case "rename":
        history.rename(command.title);
        print(`renamed: "${command.title}"`);
        return "continue";
      case "delete": {
        const picked = pickConversation(command.index);
        if (!picked) return "continue";
        print(history.remove(picked.id) ?? `deleted: ${titleOf(picked)}`);
        return "continue";
      }
      case "pin": {
        const picked = pickConversation(command.index);
        const pinned = picked ? history.togglePin(picked.id) : undefined;
        if (picked && pinned !== undefined) print(`${pinned ? "pinned" : "unpinned"}: ${titleOf(picked)}`);
        return "continue";
      }
      case "primary":
        primary = command.agent;
        print(`primary: ${primary}`);
        return "continue";
      case "help":
        HELP_LINES(primary).forEach((l) => print(l));
        return "continue";
      case "permission":
        await coordinator.setPermission(command.level, command.agent);
        saveSettings(targets(command.agent), { permission: command.level });
        print(`permission: ${command.agent ?? "all agents"} -> ${command.level}`);
        return "continue";
      case "model":
        if ((await coordinator.setModel(command.model, command.agent))?.status !== "failed") {
          saveSettings([command.agent], { model: command.model });
          print(`model: ${command.agent} -> ${command.model}`);
        }
        return "continue";
      case "effort":
        if ((await coordinator.setEffort(command.level, command.agent))?.status !== "failed") {
          saveSettings(targets(command.agent), { effort: command.level });
          print(`effort: ${command.agent ?? "all agents"} -> ${command.level}`);
        }
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
    const stoppedCommands = runner.stopAll();
    if (busy.length === 0 && stoppedCommands === 0) {
      print("No running turn. Type /exit to quit.");
      return;
    }
    await Promise.all(busy.map(({ id }) => coordinator.interrupt(id)));
  };

  return { handleLine, handleSigint, getPrimary: () => primary };
};
