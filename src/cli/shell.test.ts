import { describe, expect, it } from "vitest";
import type { AgentId, AgentStatus, PermissionLevel, TurnResult } from "../agents/agent-adapter.js";
import type { Conversation, SavedSessions } from "../project/conversation-history.js";
import { createShell, type AgentState, type ConversationList, type ShellCoordinator } from "./shell.js";

// ローカル時刻 10/05 20:26 の ISO 文字列（タイムゾーンに依存しないテストにする）
const at = (minute: number) => new Date(2026, 9, 5, 20, minute).toISOString();

class FakeHistory implements ConversationList {
  currentId = "conv-new";
  conversations: Conversation[] = [
    { id: "conv-new", startedAt: at(30), updatedAt: at(31), title: "今の会話", sessions: { claude: "c-new" } },
    { id: "conv-old", startedAt: at(20), updatedAt: at(26), title: "Remember BANANA", sessions: { claude: "c-old", codex: "x-old" } },
    { id: "conv-none", startedAt: at(10), updatedAt: at(11), sessions: { codex: "x-1" } },
  ];
  list() { return this.conversations; }
  switchTo(id: string) {
    this.currentId = id;
    return this.conversations.find((c) => c.id === id);
  }
}

class FakeCoordinator implements ShellCoordinator {
  readonly sent: Array<{ agent: AgentId; text: string }> = [];
  readonly interrupted: Array<AgentId | undefined> = [];
  readonly permissions: Array<{ level: PermissionLevel; agent: AgentId | undefined }> = [];
  states: AgentState[] = [
    { id: "claude", status: "idle", sessionId: "s-claude", permission: "edit", usage: { fiveHourPercent: 12, weeklyPercent: 50, weeklyPace: -20 } },
    { id: "codex", status: "stopped", sessionId: undefined, permission: "full", usage: {} },
  ];

  async setPermission(level: PermissionLevel, agent?: AgentId): Promise<void> {
    this.permissions.push({ level, agent });
  }

  readonly switched: SavedSessions[] = [];
  switchError: string | undefined;
  async switchSessions(sessions: SavedSessions): Promise<string | undefined> {
    if (this.switchError) return this.switchError;
    this.switched.push(sessions);
    return undefined;
  }

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
  let verbose = false;
  const history = new FakeHistory();
  const shell = createShell({
    coordinator, primary: "claude", print: (line) => printed.push(line), toggleVerbose: () => (verbose = !verbose), history,
  });
  return { coordinator, printed, shell, history };
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
    expect(printed).toEqual([
      "primary: claude",
      "claude: idle, permission edit (session s-claude)",
      "  usage: 5h 12%, 7d 50% (pace -20)",
      "codex: stopped, permission full",
      "  usage: unknown",
    ]);
  });

  it("/help は入力方法を表示する", async () => {
    const { printed, shell } = setup();
    await shell.handleLine("/help");
    expect(printed.join("\n")).toMatch(/@codex/);
    expect(printed.join("\n")).toMatch(/\/interrupt/);
  });

  it("/verbose は詳細表示を切り替えて状態を表示する", async () => {
    const { printed, shell } = setup();
    await shell.handleLine("/verbose");
    await shell.handleLine("/verbose");
    expect(printed).toEqual(["verbose: on", "verbose: off"]);
  });

  it("/permission は Coordinator に渡して結果を表示する", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleLine("/permission codex read-only");
    await shell.handleLine("/permission full");
    expect(coordinator.permissions).toEqual([{ level: "read-only", agent: "codex" }, { level: "full", agent: undefined }]);
    expect(printed).toEqual(["permission: codex -> read-only", "permission: all agents -> full"]);
  });

  it("/primary は通常のテキストの送り先を切り替える", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleLine("/primary codex");
    await shell.handleLine("hello");
    expect(printed).toEqual(["primary: codex"]);
    expect(coordinator.sent).toEqual([{ agent: "codex", text: "hello" }]);
  });

  it("/resume は過去の会話を新しい順に番号付きで表示する", async () => {
    const { printed, shell } = setup();
    await shell.handleLine("/resume");
    expect(printed).toEqual([
      '1) 10/05 20:31  claude  "今の会話"  (current)',
      '2) 10/05 20:26  claude, codex  "Remember BANANA"',
      '3) 10/05 20:11  codex  "(no input)"',
      "Type /resume <number> to switch.",
    ]);
  });

  it("/resume <番号> は会話を切り替える", async () => {
    const { coordinator, history, printed, shell } = setup();
    await shell.handleLine("/resume 2");
    expect(coordinator.switched).toEqual([{ claude: "c-old", codex: "x-old" }]);
    expect(history.currentId).toBe("conv-old");
    expect(printed).toEqual(['resumed: "Remember BANANA" (claude, codex resume on next use)']);
  });

  it("/resume で今の会話や存在しない番号を選んだら何もしない", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleLine("/resume 1");
    await shell.handleLine("/resume 9");
    expect(coordinator.switched).toEqual([]);
    expect(printed).toEqual(["already in this conversation", "no conversation #9 (see /resume)"]);
  });

  it("切り替えが拒否されたら履歴を変えずに理由を表示する", async () => {
    const { coordinator, history, printed, shell } = setup();
    coordinator.switchError = "claude is busy. Use /interrupt first.";
    await shell.handleLine("/resume 2");
    expect(history.currentId).toBe("conv-new");
    expect(printed).toEqual(["claude is busy. Use /interrupt first."]);
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
      { id: "claude", status: "busy", sessionId: "s1", permission: "edit", usage: {} },
      { id: "codex", status: "idle", sessionId: "s2", permission: "edit", usage: {} },
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
