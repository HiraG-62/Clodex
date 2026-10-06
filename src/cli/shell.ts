// 人間の入力を Coordinator の操作に変換する（DESIGN.md §8）。readline 等の I/O は index.ts が持つ
import { AGENT_IDS, type AgentId, type AgentStatus, type PermissionLevel, type TurnResult } from "../agents/agent-adapter.js";
import type { UsageSnapshot } from "../coordinator/usage-monitor.js";
import type { Conversation, SavedSessions } from "../project/conversation-history.js";
import { t } from "../i18n/i18n.js";
import { commandUsage, slashCommands } from "./commands.js";
import { resolveReferences } from "./file-references.js";
import { parseInput } from "./input.js";
import type { ModelOption } from "../agents/startup-probe.js";

export interface AgentState {
  id: AgentId;
  status: AgentStatus;
  sessionId: string | undefined;
  permission: PermissionLevel;
  model?: string;
  modelLabel?: string;
  effort?: string;
  models: readonly ModelOption[];
  usage: UsageSnapshot;
}

export interface ShellCoordinator {
  sendToAgent(agent: AgentId, text: string, images?: readonly string[]): Promise<TurnResult>;
  steerOrSend(agent: AgentId, text: string): Promise<"steered" | "queued">;
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
  // 今の会話を切り替える。前の会話の Agent は止めない（DESIGN.md §28 D1）
  switchTo(id: string): Promise<Conversation | undefined>;
  // worktree: 新しい会話用の worktree を作る。作れなければ理由を返す
  startNew(options?: { worktree?: boolean }): Promise<string | undefined>;
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
  // 今の会話の Coordinator（会話ごとに Coordinator がある。DESIGN.md §28 D1）
  coordinator: () => ShellCoordinator;
  // 同じ作業場所で別の会話の Agent が作業中か（送る前に worktree を勧める）
  busyElsewhere?: () => boolean;
  primary: AgentId;
  print: (line: string) => void;
  // terminal の詳細表示を切り替え、切り替え後の状態を返す
  toggleVerbose: () => boolean;
  history: ConversationList | (() => ConversationList);
  runner: CommandRunner;
  // 人が切り替えた設定を保存する（DESIGN.md §9 Agent の設定の保存）
  saveSettings?: (agents: readonly AgentId[], change: SettingsChange) => void;
  // @path の参照先が読んでよいファイルなら実パス（DESIGN.md §28 v0.3 A・C）
  resolveReference?: (path: string) => Promise<string | undefined>;
  projects?: {
    list(): Array<{ projectRoot: string; open: boolean; current: boolean }>;
    open(path: string): Promise<{ projectRoot: string; primary: AgentId }>;
    hasCurrent?(): boolean;
  };
  roles?: () => Partial<Record<AgentId, string>>;
  saveRole?: (agent: AgentId, text: string) => string;
}

export interface SettingsChange {
  permission?: PermissionLevel;
  model?: string;
  effort?: string;
}

export type ShellOutcome = "continue" | "exit";

// 説明の開始位置をそろえる幅
const HELP_COLUMN = 20;
const ALL_MESSAGE_PREFIX = "[Sent to both claude and codex]";
const helpLine = (usage: string, description: string) => `${usage.padEnd(HELP_COLUMN - 1)} ${description}`;

const HELP_LINES = (primary: AgentId) => [
  helpLine("<text>", t("help.text", { primary })),
  helpLine("@claude <text>", t("help.claude")),
  helpLine("@codex <text>", t("help.codex")),
  helpLine("@all <text>", t("help.all")),
  helpLine("@<agent>! <text>", t("help.steer")),
  helpLine("!<command>", t("help.run")),
  ...slashCommands().map((command) => helpLine(commandUsage(command), command.description)),
  helpLine("Ctrl+C", t("help.ctrlC")),
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
    epochSeconds === undefined ? "" : t("shell.resets", { time: format(new Date(epochSeconds * MS_PER_SECOND).toISOString()) });
  const fiveHourReset = resets(fiveHourResetsAt, clockTime);
  const weeklyReset = resets(weeklyResetsAt, shortTime);
  const pace = t("shell.pace", { pace: `${weeklyPace! > 0 ? "+" : ""}${weeklyPace}` });
  const parts = [
    ...(fiveHourPercent === undefined ? [] : [`5h ${fiveHourPercent}%${fiveHourReset ? ` (${fiveHourReset})` : ""}`]),
    ...(weeklyPercent === undefined ? [] : [`7d ${weeklyPercent}% (${[pace, weeklyReset].filter(Boolean).join(", ")})`]),
  ];
  return t("shell.usage", { parts: parts.length ? parts.join(", ") : t("shell.unknown") });
};

const TOKENS_PER_K = 1000;
const PERCENT = 100;
const kTokens = (n: number) => `${Math.round(n / TOKENS_PER_K)}k`;

const formatContext = ({ contextTokens, contextWindow }: UsageSnapshot): string => {
  if (contextTokens === undefined) return t("shell.context", { value: t("shell.unknown") });
  if (!contextWindow) return t("shell.context", { value: t("shell.contextTokens", { tokens: kTokens(contextTokens) }) });
  const percent = Math.round((contextTokens / contextWindow) * PERCENT);
  return t("shell.context", { value: t("shell.contextWindow", { tokens: kTokens(contextTokens), window: kTokens(contextWindow), percent }) });
};


const agentsOf = (c: Conversation) => (Object.keys(c.sessions) as AgentId[]).sort().join(", ");
const titleOf = (c: Conversation) => `"${c.title ?? t("shell.untitled")}"`;

export const createShell = ({
  coordinator, primary: initialPrimary, print, toggleVerbose, history: historySource, runner, saveSettings = () => {}, resolveReference = async () => undefined,
  busyElsewhere = () => false,
  projects,
  roles = () => ({}), saveRole = (_agent, text) => text,
}: ShellOptions) => {
  let primary = initialPrimary;
  const history = typeof historySource === "function" ? historySource : () => historySource;
  const targets = (agent: AgentId | undefined): readonly AgentId[] => (agent ? [agent] : AGENT_IDS);

  const listConversations = () => {
    history().list().forEach((c, i) => {
      const current = c.id === history().currentId ? t("shell.current") : "";
      print(`${i + 1}) ${shortTime(c.updatedAt)}  ${agentsOf(c)}  ${titleOf(c)}${current}`);
    });
    print(t("shell.resumeHint"));
  };

  const startFresh = async (agent: AgentId | undefined, worktree: boolean) => {
    if (agent) {
      const error = await coordinator().switchSessions({}, [agent]);
      if (error) return print(error);
      history().clearSession(agent);
      return print(t("shell.agentFresh", { agent }));
    }
    const error = await history().startNew({ worktree });
    if (error) return print(t("shell.worktreeFailed", { error }));
    const { workDir, branch } = history().list().find((c) => c.id === history().currentId) ?? {};
    print(workDir && branch ? t("shell.newWorktree", { workDir, branch }) : t("shell.newConversation"));
  };

  const resumeConversation = async (index: number) => {
    const picked = pickConversation(index);
    if (!picked) return;
    if (picked.id === history().currentId) return print(t("shell.alreadyHere"));
    await history().switchTo(picked.id);
    print(t("shell.resumed", { title: titleOf(picked) }));
  };

  const pickConversation = (index: number) => {
    const picked = history().list()[index - 1];
    if (!picked) print(t("shell.noConversation", { index }));
    return picked;
  };

  const handleLine = async (line: string): Promise<ShellOutcome> => {
    const command = parseInput(line, primary);
    if (projects?.hasCurrent && !projects.hasCurrent() && !["project", "help", "exit", "empty"].includes(command.kind)) {
      print(t("shell.noProjectSelected"));
      return "continue";
    }
    switch (command.kind) {
      case "empty":
        return "continue";
      case "send":
      case "sendAll":
        // 送信はキューに積むだけ。ターン完了は Event Bus 経由で表示される
      {
        if (busyElsewhere()) print(t("notice.sameDirBusy"));
        const resolved = await resolveReferences(command.text, resolveReference);
        const text = command.kind === "sendAll" ? `${ALL_MESSAGE_PREFIX}\n${resolved.text}` : resolved.text;
        const recipient = coordinator();
        for (const agent of command.kind === "sendAll" ? AGENT_IDS : [command.agent]) {
          if (command.steer) await recipient.steerOrSend(agent, text);
          else void recipient.sendToAgent(agent, text, resolved.images);
        }
        if (command.kind === "sendAll") print(t("notice.sentAll"));
        return "continue";
      }
      case "interrupt":
        if (!command.agent) runner.stopAll();
        await coordinator().interrupt(command.agent);
        return "continue";
      case "run":
        // 終了を待たずに次の入力を受け付ける。出力は runner が表示する
        void runner.run(command.command);
        return "continue";
      case "status":
        print(t("shell.primary", { agent: primary }));
        {
          const { workDir, branch } = history().list().find((c) => c.id === history().currentId) ?? {};
          if (workDir && branch) print(t("shell.worktree", { workDir, branch }));
        }
        for (const { id, status, sessionId, permission, model, modelLabel, effort, usage } of coordinator().status()) {
          print(t("shell.status", {
            id, status, permission, model: modelLabel ?? model ?? t("shell.default"), effort: effort ?? t("shell.default"),
            session: sessionId ? t("shell.session", { id: sessionId }) : "",
          }));
          print(formatUsage(usage));
          print(formatContext(usage));
        }
        for (const input of coordinator().pendingInputs()) print(t("shell.queued", { id: input.id, agent: input.agent, text: input.text }));
        return "continue";
      case "project":
        if (command.path) {
          if (!projects) return "continue";
          const opened = await projects.open(command.path);
          primary = opened.primary;
          print(t("shell.projectOpened", { project: opened.projectRoot }));
          return "continue";
        }
        if (!projects?.list().length) print(t("shell.noProjects"));
        else for (const project of projects.list()) {
          print(`${project.projectRoot}${project.current ? t("shell.projectCurrent") : project.open ? "" : t("shell.projectSaved")}`);
        }
        return "continue";
      case "role":
        if (command.agent && command.text !== undefined) {
          const saved = saveRole(command.agent, command.text);
          print(t("shell.roleSaved", { agent: command.agent, text: saved }));
          print(t("shell.roleRestart", { agent: command.agent }));
          return "continue";
        }
        for (const agent of command.agent ? [command.agent] : AGENT_IDS) {
          print(t("shell.role", { agent, text: roles()[agent] ?? t("shell.roleUnset") }));
        }
        return "continue";
      case "cancel": {
        const canceled = coordinator().cancelInput(command.id);
        print(canceled
          ? t("shell.canceled", { id: canceled.id, agent: canceled.agent })
          : t("shell.nothingToCancel", { id: command.id ? `: ${command.id}` : "" }));
        return "continue";
      }
      case "new":
        await startFresh(command.agent, command.worktree === true);
        return "continue";
      case "compact":
        // 1 ターンとしてキューに積むだけ。進み具合は Event Bus 経由で表示される
        void coordinator().compact(command.agent);
        print(t("shell.compactQueued", { target: command.agent ?? t("shell.runningAgents") }));
        return "continue";
      case "resume":
        if (command.index === undefined) listConversations();
        else await resumeConversation(command.index);
        return "continue";
      case "rename":
        history().rename(command.title);
        print(t("shell.renamed", { title: command.title }));
        return "continue";
      case "delete": {
        const picked = pickConversation(command.index);
        if (!picked) return "continue";
        print(history().remove(picked.id) ?? t("shell.deleted", { title: titleOf(picked) }));
        return "continue";
      }
      case "pin": {
        const picked = pickConversation(command.index);
        const pinned = picked ? history().togglePin(picked.id) : undefined;
        if (picked && pinned !== undefined) print(t(pinned ? "shell.pinned" : "shell.unpinned", { title: titleOf(picked) }));
        return "continue";
      }
      case "primary":
        primary = command.agent;
        print(t("shell.primary", { agent: primary }));
        return "continue";
      case "help":
        HELP_LINES(primary).forEach((l) => print(l));
        return "continue";
      case "permission":
        await coordinator().setPermission(command.level, command.agent);
        saveSettings(targets(command.agent), { permission: command.level });
        print(t("shell.permission", { target: command.agent ?? t("shell.allAgents"), level: command.level }));
        return "continue";
      case "model":
        if ((await coordinator().setModel(command.model, command.agent))?.status !== "failed") {
          saveSettings([command.agent], { model: command.model });
          print(t("shell.model", { agent: command.agent, model: command.model }));
        }
        return "continue";
      case "effort":
        if ((await coordinator().setEffort(command.level, command.agent))?.status !== "failed") {
          saveSettings(targets(command.agent), { effort: command.level });
          print(t("shell.effort", { target: command.agent ?? t("shell.allAgents"), level: command.level }));
        }
        return "continue";
      case "verbose":
        print(t("shell.verbose", { state: t(toggleVerbose() ? "shell.on" : "shell.off") }));
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
    const busy = coordinator().status().filter((s) => s.status === "busy");
    const stoppedCommands = runner.stopAll();
    if (busy.length === 0 && stoppedCommands === 0) {
      print(t("shell.noTurn"));
      return;
    }
    await Promise.all(busy.map(({ id }) => coordinator().interrupt(id)));
  };

  return { handleLine, handleSigint, getPrimary: () => primary };
};
