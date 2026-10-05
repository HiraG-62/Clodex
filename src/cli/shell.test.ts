import { describe, expect, it } from "vitest";
import type { AgentId, AgentStatus, TurnResult } from "../agents/agent-adapter.js";
import { createShell, type ShellCoordinator } from "./shell.js";

class FakeCoordinator implements ShellCoordinator {
  readonly sent: Array<{ agent: AgentId; text: string }> = [];
  readonly interrupted: Array<AgentId | undefined> = [];
  states: Array<{ id: AgentId; status: AgentStatus; sessionId: string | undefined }> = [
    { id: "claude", status: "idle", sessionId: "s-claude" },
    { id: "codex", status: "stopped", sessionId: undefined },
  ];

  sendToAgent(agent: AgentId, text: string): Promise<TurnResult> {
    this.sent.push({ agent, text });
    return new Promise(() => {}); // ターン完了を待たずに次の入力を受け付けることを確認する
  }

  async interrupt(agent?: AgentId): Promise<void> {
    this.interrupted.push(agent);
  }

  status() {
    return this.states;
  }
}

const setup = () => {
  const coordinator = new FakeCoordinator();
  const printed: string[] = [];
  const shell = createShell({ coordinator, primary: "claude", print: (line) => printed.push(line) });
  return { coordinator, printed, shell };
};

describe("createShell", () => {
  it("送信はターン完了を待たずに戻る", async () => {
    const { coordinator, shell } = setup();
    await expect(shell.handleLine("hello")).resolves.toBe("continue");
    await expect(shell.handleLine("@codex review")).resolves.toBe("continue");
    expect(coordinator.sent).toEqual([{ agent: "claude", text: "hello" }, { agent: "codex", text: "review" }]);
  });

  it("/interrupt を Coordinator に渡す", async () => {
    const { coordinator, shell } = setup();
    await shell.handleLine("/interrupt codex");
    await shell.handleLine("/interrupt");
    expect(coordinator.interrupted).toEqual(["codex", undefined]);
  });

  it("/status は各 Agent の状態を表示する", async () => {
    const { printed, shell } = setup();
    await shell.handleLine("/status");
    expect(printed).toEqual(["claude: idle (session s-claude)", "codex: stopped"]);
  });

  it("/help は入力方法を表示する", async () => {
    const { printed, shell } = setup();
    await shell.handleLine("/help");
    expect(printed.join("\n")).toMatch(/@codex/);
    expect(printed.join("\n")).toMatch(/\/interrupt/);
  });

  it("/exit は exit を返す", async () => {
    const { shell } = setup();
    await expect(shell.handleLine("/exit")).resolves.toBe("exit");
  });

  it("未対応・不正な入力はメッセージを表示して何もしない", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleLine("@all hi");
    await shell.handleLine("/foo");
    expect(coordinator.sent).toEqual([]);
    expect(printed).toHaveLength(2);
  });

  it("Ctrl+C は実行中の Agent だけ interrupt する", async () => {
    const { coordinator, shell } = setup();
    coordinator.states = [
      { id: "claude", status: "busy", sessionId: "s1" },
      { id: "codex", status: "idle", sessionId: "s2" },
    ];
    await shell.handleSigint();
    expect(coordinator.interrupted).toEqual(["claude"]);
  });

  it("実行中の Agent が無ければ Ctrl+C は終了方法を案内する", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleSigint();
    expect(coordinator.interrupted).toEqual([]);
    expect(printed.join("\n")).toMatch(/\/exit/);
  });
});
