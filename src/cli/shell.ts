// 人間の入力を Coordinator の操作に変換する（DESIGN.md §8）。readline 等の I/O は index.ts が持つ
import type { AgentId, AgentStatus, PermissionLevel, TurnResult } from "../agents/agent-adapter.js";
import type { UsageSnapshot } from "../coordinator/usage-monitor.js";
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
  status(): AgentState[];
}

export interface ShellOptions {
  coordinator: ShellCoordinator;
  primary: AgentId;
  print: (line: string) => void;
  // terminal の詳細表示を切り替え、切り替え後の状態を返す
  toggleVerbose: () => boolean;
}

export type ShellOutcome = "continue" | "exit";

const HELP_LINES = (primary: AgentId) => [
  `<text>              send to the primary agent (${primary})`,
  "@claude <text>      send to Claude",
  "@codex <text>       send to Codex",
  "/interrupt [agent]  interrupt the running turn (all agents if omitted)",
  "/status             show agent status and usage",
  "/primary <agent>    change where plain text goes",
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

export const createShell = ({ coordinator, primary: initialPrimary, print, toggleVerbose }: ShellOptions) => {
  let primary = initialPrimary;

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
        }
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
