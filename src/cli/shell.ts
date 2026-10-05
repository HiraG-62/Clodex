// 人間の入力を Coordinator の操作に変換する（DESIGN.md §8）。readline 等の I/O は index.ts が持つ
import type { AgentId, AgentStatus, TurnResult } from "../agents/agent-adapter.js";
import { parseInput } from "./input.js";

export interface ShellCoordinator {
  sendToAgent(agent: AgentId, text: string): Promise<TurnResult>;
  interrupt(agent?: AgentId): Promise<void>;
  status(): Array<{ id: AgentId; status: AgentStatus; sessionId: string | undefined }>;
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
  "/status             show agent status",
  "/verbose            toggle detailed output (tools, usage, intermediate text)",
  "/exit               stop all agents and quit",
  "Ctrl+C              interrupt running turns",
];

export const createShell = ({ coordinator, primary, print, toggleVerbose }: ShellOptions) => {
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
        for (const { id, status, sessionId } of coordinator.status()) {
          print(`${id}: ${status}${sessionId ? ` (session ${sessionId})` : ""}`);
        }
        return "continue";
      case "help":
        HELP_LINES(primary).forEach((l) => print(l));
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
