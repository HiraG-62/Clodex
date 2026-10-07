import { DEFAULT_LIMITS, LIMIT_KEYS } from "../coordinator/budget-manager.js";
import { describe, expect, it } from "vitest";
import type { AgentId, AgentStatus, PermissionLevel, TurnResult } from "../agents/agent-adapter.js";
import type { Conversation, SavedSessions } from "../project/conversation-history.js";
import { createShell, type AgentState, type ConversationList, type PendingInput, type ShellCoordinator } from "./shell.js";
import type { ManagedProcess } from "../process/process-manager.js";
import { startWebServer } from "../web/web-server.js";
import { WebFeed } from "../web/web-feed.js";
import { buildWebPage } from "../web/web-page.js";

// ローカル時刻 10/05 20:26 の ISO 文字列（タイムゾーンに依存しないテストにする）
const at = (minute: number) => new Date(2026, 9, 5, 20, minute).toISOString();

class FakeHistory implements ConversationList {
  currentId = "conv-new";
  conversations: Conversation[] = [
    { id: "conv-new", startedAt: at(30), updatedAt: at(31), title: "今の会話", sessions: { claude: "c-new" } },
    { id: "conv-old", startedAt: at(20), updatedAt: at(26), title: "Remember BANANA", sessions: { claude: "c-old", codex: "x-old" } },
    { id: "conv-none", startedAt: at(10), updatedAt: at(11), sessions: { codex: "x-1" } },
  ];
  started: Array<{ worktree?: boolean } | undefined> = [];
  worktreeError: string | undefined;
  list() { return this.conversations; }
  async startNew(options?: { worktree?: boolean }) {
    if (options?.worktree && this.worktreeError) return this.worktreeError;
    this.started.push(options);
    this.currentId = "conv-fresh";
    if (options?.worktree) this.conversations.push({ id: "conv-fresh", startedAt: at(40), updatedAt: at(40), sessions: {}, workDir: "C:\\dev\\app-1a2b", branch: "clodex/1a2b" });
    return undefined;
  }
  readonly cleared: AgentId[] = [];
  clearSession(agent: AgentId) {
    this.cleared.push(agent);
  }
  readonly renamed: string[] = [];
  rename(title: string) { this.renamed.push(title); }
  readonly removed: string[] = [];
  remove(id: string) {
    if (id === this.currentId) return "cannot delete the current conversation";
    this.removed.push(id);
    return undefined;
  }
  togglePin(id: string) {
    const found = this.conversations.find((c) => c.id === id);
    if (!found) return undefined;
    found.pinned = !found.pinned;
    return found.pinned;
  }
  async switchTo(id: string) {
    this.currentId = id;
    return this.conversations.find((c) => c.id === id);
  }
}

class FakeCoordinator implements ShellCoordinator {
  questions = [{ id: "q1", agent: "claude" as const, questions: [{ question: "方針", options: [{ label: "A" }, { label: "B" }] }] }];
  answers: Array<{ id: string; value: unknown }> = [];
  answerError: string | undefined;
  pendingQuestions() { return this.questions; }
  answer(id: string, value: unknown) { this.answers.push({ id, value }); return this.answerError; }
  readonly sent: Array<{ agent: AgentId; text: string }> = [];
  readonly interrupted: Array<AgentId | undefined> = [];
  readonly permissions: Array<{ level: PermissionLevel; agent: AgentId | undefined }> = [];
  readonly models: Array<{ model: string; agent: AgentId }> = [];
  readonly efforts: Array<{ level: string; agent: AgentId | undefined }> = [];
  settingResult: TurnResult | undefined;
  states: AgentState[] = [
    {
      id: "claude", status: "idle", sessionId: "s-claude", permission: "edit", model: "haiku", effort: "high", models: ["default", "opus", "sonnet", "haiku"].map((value) => ({ value, label: value })),
      usage: {
        fiveHourPercent: 12, fiveHourResetsAt: new Date(2026, 9, 5, 22, 30).getTime() / 1000,
        weeklyPercent: 50, weeklyPace: -20, weeklyResetsAt: new Date(2026, 9, 9, 10, 0).getTime() / 1000,
        contextTokens: 85400, contextWindow: 200000,
      },
    },
    { id: "codex", status: "stopped", sessionId: undefined, permission: "full", models: [], usage: {} },
  ];

  async setPermission(level: PermissionLevel, agent?: AgentId): Promise<void> {
    this.permissions.push({ level, agent });
  }
  async setModel(model: string, agent: AgentId): Promise<TurnResult | void> {
    this.models.push({ model, agent });
    return this.settingResult;
  }
  async setEffort(level: string, agent?: AgentId): Promise<TurnResult | void> {
    this.efforts.push({ level, agent });
    return this.settingResult;
  }

  pending: PendingInput[] = [{ id: "in2", agent: "codex", text: "queued" }];
  readonly canceled: Array<string | undefined> = [];
  pendingInputs() { return this.pending; }
  cancelInput(id?: string) {
    this.canceled.push(id);
    return this.pending.find((p) => p.id === (id ?? "in2"));
  }

  readonly switched: SavedSessions[] = [];
  readonly switchTargets: Array<readonly AgentId[] | undefined> = [];
  switchError: string | undefined;
  async switchSessions(sessions: SavedSessions, targets?: readonly AgentId[]): Promise<string | undefined> {
    if (this.switchError) return this.switchError;
    this.switched.push(sessions);
    this.switchTargets.push(targets);
    return undefined;
  }

  readonly steeredInputs: Array<{ agent: AgentId; text: string }> = [];
  async steerOrSend(agent: AgentId, text: string): Promise<"steered" | "queued"> {
    this.steeredInputs.push({ agent, text });
    return "steered";
  }

  readonly images: Array<readonly string[] | undefined> = [];
  sendToAgent(agent: AgentId, text: string, images?: readonly string[]): Promise<TurnResult> {
    this.sent.push({ agent, text });
    this.images.push(images);
    return new Promise(() => {}); // ターン完了を待たずに次の入力を受け付けることを確認する
  }

  async interrupt(agent?: AgentId): Promise<void> {
    this.interrupted.push(agent);
  }

  readonly compacted: Array<AgentId | undefined> = [];
  compact(agent?: AgentId): Promise<unknown> {
    this.compacted.push(agent);
    return new Promise(() => {}); // 完了を待たずに次の入力を受け付けることを確認する
  }

  status() {
    return this.states;
  }
}

class FakeRunner {
  readonly commands: string[] = [];
  running = 0;
  stops = 0;
  run(command: string): Promise<void> {
    this.commands.push(command);
    return new Promise(() => {}); // 終了を待たずに次の入力を受け付けることを確認する
  }
  stopAll(): number {
    this.stops++;
    const stopped = this.running;
    this.running = 0;
    return stopped;
  }
}

const setup = () => {
  const coordinator = new FakeCoordinator();
  const runner = new FakeRunner();
  const background = {
    starts: [] as string[], stops: 0, killed: [] as number[],
    entries: [] as ManagedProcess[],
    start(command: string) { this.starts.push(command); return this.starts.length; },
    stopAll() { this.stops++; },
    kill(id: number) { this.killed.push(id); return id === 1; },
    list() { return this.entries; },
    output(id: number) { return id === 1 ? ["line one", "line two"] : undefined; },
  };
  const printed: string[] = [];
  const notified: string[] = [];
  const levels: Array<"info" | "warn" | undefined> = [];
  let verbose = false;
  const history = new FakeHistory();
  const busy = { value: false };
  const saved: Array<{ agents: readonly AgentId[]; change: object }> = [];
  const roles: Partial<Record<AgentId, string>> = { claude: "設計" };
  const references: string[] = [];
  const projects = {
    list: () => [{ projectRoot: "C:\\dev\\one", open: true, current: true }, { projectRoot: "C:\\dev\\two", open: false, current: false }],
    open: async (path: string) => ({ projectRoot: path, primary: "codex" as AgentId }),
  };
  let limits = { ...DEFAULT_LIMITS };
  let sandboxEnabled = false;
  const sandbox = { enabled: () => sandboxEnabled, ready: async () => true, set: async (enabled: boolean) => { sandboxEnabled = enabled; }, uninstall: async () => { sandboxEnabled = false; } };
  const shell = createShell({
    sandbox,
    coordinator: () => coordinator, primary: "claude", notify: (text, level) => { notified.push(text); levels.push(level); }, busyElsewhere: () => busy.value, print: (line) => printed.push(line), toggleVerbose: () => (verbose = !verbose), history, runner,
    limits: { get: () => limits, set: (name, value) => { limits[LIMIT_KEYS[name]] = value; }, reset: () => { limits = { ...DEFAULT_LIMITS }; } },
    saveSettings: (agents, change) => saved.push({ agents, change }),
    resolveReference: async (path) => {
      references.push(path);
      return ({ "src/a.ts": "C:/p/src/a.ts", "shot.png": "C:/up/shot.png" } as Record<string, string>)[path];
    },
    projects, processes: background,
    roles: () => roles,
    saveRole: (agent, value) => { roles[agent] = value; return value; },
  });
  return { coordinator, printed, notified, levels, shell, history, runner, saved, busy, projects, roles, background, references, sandbox };
};

describe("createShell", () => {
  it("Web の /sandbox on 失敗は表示し、入力 API は 204 を返す", async()=>{
    const {shell,sandbox,printed}=setup();sandbox.set=async()=>{throw new Error("Invalid runtime ACL");};
    const server=await startWebServer({port:0,token:"test-token",feed:new WebFeed(),page:buildWebPage("en"),
      onInput:async line=>{await shell.handleLine(line);},listFiles:async()=>[],
      preview:{file:async()=>({ok:false,status:404,message:""}),diff:async()=>({ok:false,status:404,message:""})},
      upload:{maxBytes:0,accepts:()=>false,save:async()=>""}});
    try{
      const response=await fetch(`${server.url}/api/input`,{method:"POST",headers:{cookie:"clodex_token=test-token"},body:JSON.stringify({line:"/sandbox on"})});
      expect(response.status).toBe(204);expect(printed.at(-1)).toContain("Invalid runtime ACL");
    }finally{await server.close();}
  });
  it.each(["/sandbox", "/sandbox on", "/sandbox off", "/sandbox uninstall"])("%s の失敗は表示し、入力処理を reject しない", async command => {
    const {shell,printed,sandbox}=setup();
    const failure=async()=>{throw new Error("sandbox failed");};
    sandbox.ready=failure;sandbox.set=failure;sandbox.uninstall=failure;
    await expect(shell.handleLine(command)).resolves.toBe("continue");
    expect(printed.at(-1)).toContain("sandbox failed");
  });
  it("sandbox の状態を表示し、on の間は permission の変更と保存を拒否する", async () => {
    const { shell, coordinator, saved, printed } = setup();
    await shell.handleLine("/sandbox on");
    expect(printed.at(-1)).toContain("sandbox: on");
    await shell.handleLine("/permission read-only");
    expect(coordinator.permissions).toHaveLength(0);
    expect(saved).toHaveLength(0);
    await shell.handleLine("/sandbox uninstall");
    expect(printed.at(-1)).toContain("sandbox: off");
    await shell.handleLine("/permission read-only");
    expect(coordinator.permissions).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });
  it("background は Ctrl+C と /interrupt で止めず /exit で止める", async () => {
    const { shell, background } = setup();
    await shell.handleLine("!& pnpm dev");
    expect(background.starts).toEqual(["pnpm dev"]);
    await shell.handleSigint();
    await shell.handleLine("/interrupt");
    expect(background.stops).toBe(0);
    await shell.handleLine("/exit");
    expect(background.stops).toBe(1);
  });
  it("process の一覧・出力を表示し番号で停止する", async () => {
    const { shell, background, printed } = setup();
    await shell.handleLine("/processes");
    expect(printed.at(-1)).toBe("No background processes");
    background.entries = [{ id: 1, command: "pnpm test", status: "exited", exitCode: 1, startedAt: 0, endedAt: 3200 }];
    await shell.handleLine("/processes");
    expect(printed.at(-1)).toBe("#1 exit 1 3.2s  pnpm test");
    await shell.handleLine("/processes 1");
    expect(printed.slice(-2)).toEqual(["line one", "line two"]);
    await shell.handleLine("/kill 1");
    expect(background.killed).toEqual([1]);
  });
  it("@all は両 Agent に接頭行と画像を送り notice を出す", async () => {
    const { shell, coordinator, printed, references } = setup();
    await shell.handleLine("@all hello @shot.png");
    expect(coordinator.sent.map(({ agent }) => agent)).toEqual(["claude", "codex"]);
    expect(coordinator.sent.every(({ text }) => text.startsWith("[Sent to both claude and codex]\n"))).toBe(true);
    expect(coordinator.images).toEqual([["C:/up/shot.png"], ["C:/up/shot.png"]]);
    expect(printed).toContain("@all: sent to claude and codex");
    expect(references).toEqual(["shot.png"]);
  });
  it("@all! は両 Agent に割り込む", async () => {
    const { shell, coordinator } = setup();
    await shell.handleLine("@all! hello");
    expect(coordinator.steeredInputs).toEqual(["claude", "codex"].map((agent) => ({ agent, text: "[Sent to both claude and codex]\nhello" })));
  });
  it("/role で役割を表示し、編集後に次の session の案内を出す", async () => {
    const { shell, printed, roles } = setup();
    await shell.handleLine("/role");
    expect(printed.join("\n")).toContain("設計");
    await shell.handleLine("/role codex 実装を担当");
    expect(roles.codex).toBe("実装を担当");
    expect(printed.at(-1)).toContain("/new codex");
  });
  it("/project で一覧を表示し、指定パスへ切り替える", async () => {
    const { shell, printed } = setup();
    await shell.handleLine("/project");
    expect(printed.join("\n")).toContain("C:\\dev\\one");
    expect(printed.join("\n")).toContain("C:\\dev\\two");
    await shell.handleLine("/project C:\\dev\\two");
    expect(shell.getPrimary()).toBe("codex");
  });
  it("送信はターン完了を待たずに戻る", async () => {
    const { coordinator, shell } = setup();
    await expect(shell.handleLine("hello")).resolves.toBe("continue");
    await expect(shell.handleLine("@codex review")).resolves.toBe("continue");
    expect(coordinator.sent).toEqual([{ agent: "claude", text: "hello" }, { agent: "codex", text: "review" }]);
  });

  it("@path の画像は実パスで Agent に画像として渡す", async () => {
    const { coordinator, shell } = setup();
    await shell.handleLine("@codex @shot.png を見て");
    expect(coordinator.images).toEqual([["C:/up/shot.png"]]);
  });

  it("@agent! は Coordinator の steerOrSend に渡す", async () => {
    const { coordinator, shell } = setup();
    await shell.handleLine("@codex! b.ts も");
    expect(coordinator.steeredInputs).toEqual([{ agent: "codex", text: "b.ts も" }]);
    expect(coordinator.sent).toEqual([]);
  });

  it("@path で指定した project のファイルを本文の末尾に参照として添える", async () => {
    const { coordinator, shell } = setup();
    await shell.handleLine("@codex @src/a.ts を直して");
    await shell.handleLine("@missing.ts は無視");
    expect(coordinator.sent).toEqual([
      { agent: "codex", text: "@src/a.ts を直して\n\nReferenced files:\n- src/a.ts" },
      { agent: "claude", text: "@missing.ts は無視" },
    ]);
  });

  it("/cancel は配送待ちの入力を取り消し、取り消せなければその旨を表示する", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleLine("/cancel");
    await shell.handleLine("/cancel in9");
    expect(coordinator.canceled).toEqual([undefined, "in9"]);
    expect(printed).toEqual(["canceled: in2 -> codex", "nothing to cancel: in9"]);
  });

  it("/interrupt を Coordinator に渡し、Agent 指定なしなら実行中の command も止める", async () => {
    const { coordinator, runner, shell } = setup();
    await shell.handleLine("/interrupt codex");
    expect(runner.stops).toBe(0);
    await shell.handleLine("/interrupt");
    expect(coordinator.interrupted).toEqual(["codex", undefined]);
    expect(runner.stops).toBe(1);
  });

  it("!command は終了を待たずに実行し、Agent には送らない", async () => {
    const { coordinator, runner, shell } = setup();
    await expect(shell.handleLine("!git status")).resolves.toBe("continue");
    expect(runner.commands).toEqual(["git status"]);
    expect(coordinator.sent).toEqual([]);
  });

  it("/status は各 Agent の状態を表示する", async () => {
    const { printed, shell } = setup();
    await shell.handleLine("/status");
    expect(printed).toEqual([
      "primary: claude",
      "claude: idle, permission edit, model haiku, effort high (session s-claude)",
      "  usage: 5h 12% (resets 22:30), 7d 50% (pace -20, resets 10/09 10:00)",
      "  context: 85k / 200k tokens (43%)",
      "codex: stopped, permission full, model default, effort default",
      "  usage: unknown",
      "  context: unknown",
      "queued: in2 -> codex: queued",
    ]);
  });

  it("/help は入力方法を表示する", async () => {
    const { printed, shell } = setup();
    await shell.handleLine("/help");
    expect(printed.join("\n")).toMatch(/@codex/);
    expect(printed.join("\n")).toMatch(/\/interrupt/);
    expect(printed.join("\n")).toMatch(/\/model/);
    expect(printed.join("\n")).toMatch(/\/effort/);
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

  it("/model と /effort を Coordinator に渡す", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleLine("/model claude haiku");
    await shell.handleLine("/effort codex low");
    await shell.handleLine("/effort high");
    expect(coordinator.models).toEqual([{ agent: "claude", model: "haiku" }]);
    expect(coordinator.efforts).toEqual([{ agent: "codex", level: "low" }, { agent: undefined, level: "high" }]);
    expect(printed).toEqual(["model: claude -> haiku", "effort: codex -> low", "effort: all agents -> high"]);
  });

  it("設定ターンが failed のとき成功表示を出さず、保存もしない", async () => {
    const { coordinator, printed, shell, saved } = setup();
    coordinator.settingResult = { status: "failed", text: "Model not found" };
    await shell.handleLine("/model claude missing-model");
    await shell.handleLine("/effort claude high");
    expect(printed).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("切り替えた権限・model・effort を対象の Agent ごとに保存する", async () => {
    const { shell, saved } = setup();
    await shell.handleLine("/permission full");
    await shell.handleLine("/permission codex read-only");
    await shell.handleLine("/model claude haiku");
    await shell.handleLine("/effort low");
    expect(saved).toEqual([
      { agents: ["claude", "codex"], change: { permission: "full" } },
      { agents: ["codex"], change: { permission: "read-only" } },
      { agents: ["claude"], change: { model: "haiku" } },
      { agents: ["claude", "codex"], change: { effort: "low" } },
    ]);
  });

  it("/rename は今の会話の名前を変える", async () => {
    const { history, printed, notified, shell } = setup();
    await shell.handleLine("/rename 設計の相談 その2");
    expect(history.renamed).toEqual(["設計の相談 その2"]);
    expect(notified).toEqual(["renamed: \"設計の相談 その2\""]);
    expect(printed).toEqual([]);
  });

  it("/delete と /pin は /resume の番号で会話を指定する", async () => {
    const { history, printed, notified, shell } = setup();
    await shell.handleLine("/delete 1");
    await shell.handleLine("/delete 2");
    await shell.handleLine("/pin 3");
    await shell.handleLine("/pin 3");
    await shell.handleLine("/pin 9");
    expect(history.removed).toEqual(["conv-old"]);
    expect(notified).toEqual([
      "cannot delete the current conversation",
      "deleted: \"Remember BANANA\"",
      "pinned: \"(no input)\"",
      "unpinned: \"(no input)\"",
    ]);
    expect(printed).toEqual(["no conversation #9"]);
  });

  it("/primary は通常のテキストの送り先を切り替える", async () => {
    const { coordinator, printed, shell } = setup();
    expect(shell.getPrimary()).toBe("claude");
    await shell.handleLine("/primary codex");
    expect(shell.getPrimary()).toBe("codex");
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
      "/resume <number> to switch",
    ]);
  });

  it("/resume <番号> は会話を切り替え、前の会話の Agent は止めない", async () => {
    const { coordinator, history, printed, notified, shell } = setup();
    await shell.handleLine("/resume 2");
    expect(coordinator.switched).toEqual([]);
    expect(history.currentId).toBe("conv-old");
    expect(notified).toEqual(['switched to: "Remember BANANA"']);
    expect(printed).toEqual([]);
  });

  it("/resume で今の会話や存在しない番号を選んだら何もしない", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleLine("/resume 1");
    await shell.handleLine("/resume 9");
    expect(coordinator.switched).toEqual([]);
    expect(printed).toEqual(["already in this conversation", "no conversation #9"]);
  });

  it("/new は新しい会話を今の会話にし、前の会話の Agent は止めない", async () => {
    const { coordinator, history, printed, notified, shell } = setup();
    await shell.handleLine("/new");
    expect(coordinator.switched).toEqual([]);
    expect(history.started).toEqual([{ worktree: false }]);
    expect(notified).toEqual(["new conversation"]);
    expect(printed).toEqual([]);
  });

  it("/new worktree は worktree で新しい会話を始め、作れなければ理由を表示する", async () => {
    const { history, printed, notified, shell } = setup();
    await shell.handleLine("/new worktree");
    expect(history.started).toEqual([{ worktree: true }]);
    expect(notified).toEqual(["new conversation: worktree C:\\dev\\app-1a2b (clodex/1a2b)"]);
    history.worktreeError = "fatal: not a git repository";
    await shell.handleLine("/new worktree");
    expect(notified.at(-1)).toBe("could not create a worktree: fatal: not a git repository");
  });

  it("同じ作業場所で別の会話が作業中なら、送る前に worktree を勧める", async () => {
    const { busy, coordinator, printed, notified, levels, shell } = setup();
    busy.value = true;
    await shell.handleLine("hello");
    expect(notified).toEqual(["Another chat is working in the same directory (parallel: /new worktree)"]);
    expect(coordinator.sent).toEqual([{ agent: "claude", text: "hello" }]);
    expect(printed).toEqual([]);
    expect(levels).toEqual(["warn"]);
  });

  it("/new <agent> はその Agent だけを今の会話の中で始め直す", async () => {
    const { coordinator, history, printed, shell } = setup();
    await shell.handleLine("/new codex");
    expect(coordinator.switchTargets).toEqual([["codex"]]);
    expect(history.started).toEqual([]);
    expect(history.cleared).toEqual(["codex"]);
    expect(printed).toEqual(["codex: new session"]);
  });

  it("/new <agent> が拒否されたら理由を表示する", async () => {
    const { coordinator, history, printed, shell } = setup();
    coordinator.switchError = "codex is busy. Use /interrupt first.";
    await shell.handleLine("/new codex");
    expect(history.cleared).toEqual([]);
    expect(printed).toEqual(["codex is busy. Use /interrupt first."]);
  });

  it("/compact は完了を待たずに Coordinator に渡す", async () => {
    const { coordinator, printed, shell } = setup();
    await expect(shell.handleLine("/compact claude")).resolves.toBe("continue");
    await shell.handleLine("/compact");
    expect(coordinator.compacted).toEqual(["claude", undefined]);
    expect(printed).toEqual(["compact queued: claude", "compact queued: running agents"]);
  });

  it("/exit は exit を返す", async () => {
    const { shell } = setup();
    await expect(shell.handleLine("/exit")).resolves.toBe("exit");
  });

  it("未対応・不正な入力はメッセージを表示して何もしない", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleLine("@all");
    await shell.handleLine("/foo");
    expect(coordinator.sent).toEqual([]);
    expect(printed).toHaveLength(2);
  });

  it("Ctrl+C は実行中の Agent だけ interrupt する", async () => {
    const { coordinator, shell } = setup();
    coordinator.states = [
      { id: "claude", status: "busy", sessionId: "s1", permission: "edit", models: [], usage: {} },
      { id: "codex", status: "idle", sessionId: "s2", permission: "edit", models: [], usage: {} },
    ];
    await shell.handleSigint();
    expect(coordinator.interrupted).toEqual(["claude"]);
  });

  it("Ctrl+C は実行中の command も止める", async () => {
    const { coordinator, printed, runner, shell } = setup();
    runner.running = 1;
    await shell.handleSigint();
    expect(runner.stops).toBe(1);
    expect(coordinator.interrupted).toEqual([]);
    expect(printed.join("\n")).not.toMatch(/\/exit/);
  });

  it("実行中の Agent が無ければ Ctrl+C は終了方法を案内する", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleSigint();
    expect(coordinator.interrupted).toEqual([]);
    expect(printed.join("\n")).toMatch(/\/exit/);
  });
});

it.each(["/new", "/new worktree", "/resume 2", "/rename 名前", "/delete 1", "/delete 2", "/pin 2", "/project C:/dev/two"])("%s の操作結果はログに入れない", async (command) => {
  const { shell, printed, notified } = setup();
  await shell.handleLine(command);
  expect(notified).toHaveLength(1);
  expect(printed).toEqual([]);
});

it("/answer は JSON の回答と 1 問への自由記述を渡す", async () => {
  const { shell, coordinator, notified } = setup();
  await shell.handleLine('/answer q1 [["A"]]');
  await shell.handleLine("/answer q1 自由な回答");
  expect(coordinator.answers).toEqual([{ id: "q1", value: [["A"]] }, { id: "q1", value: [["自由な回答"]] }]);
  expect(notified).toEqual([]);
});

it("/answer は複数問への自由記述と不明な ID を拒否し、検証エラーを通知する", async () => {
  const { shell, coordinator, notified } = setup();
  coordinator.questions[0]!.questions.push(coordinator.questions[0]!.questions[0]!);
  await shell.handleLine("/answer q1 自由記述");
  await shell.handleLine("/answer missing 自由記述");
  expect(coordinator.answers).toEqual([]);
  expect(notified).toHaveLength(2);
  coordinator.answerError = "Invalid answers";
  await shell.handleLine('/answer q1 {"invalid":true}');
  expect(notified.at(-1)).toBe("Invalid answers");
});

it("/limits の表示・変更・リセットを project の操作に渡す", async () => {
  const { shell, printed } = setup();
  await shell.handleLine("/limits messages 16");
  expect(printed.at(-1)).toBe("limits: messages 16");
  await shell.handleLine("/limits");
  expect(printed.slice(-4)).toEqual(["messages 16 (default 8)", "reviews 3", "delegations 4", "depth 2"]);
  await shell.handleLine("/limits reset");
  expect(printed.at(-1)).toBe("limits: reset to defaults");
  await shell.handleLine("/limits");
  expect(printed.slice(-4)).toEqual(["messages 8", "reviews 3", "delegations 4", "depth 2"]);
});
