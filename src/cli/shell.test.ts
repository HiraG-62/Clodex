import { describe, expect, it } from "vitest";
import type { AgentId, PermissionLevel, TurnResult } from "../agents/agent-adapter.js";
import { DEFAULT_LIMITS, LIMIT_KEYS } from "../coordinator/budget-manager.js";
import type { PendingMessage, SoloMode } from "../coordinator/coordinator.js";
import type { Conversation, SavedSessions } from "../project/conversation-history.js";
import type { CommandResult } from "./command-runner.js";
import { type AgentState, type ConversationList, createShell, type PendingInput, type ShellCoordinator } from "./shell.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

import type { ManagedProcess } from "../process/process-manager.js";
import { WebFeed } from "../web/web-feed.js";
import { buildWebPage } from "../web/web-page.js";
import { startWebServer } from "../web/web-server.js";

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
  worktreeMove: "ok" | "already" | "busy" | "failed" = "ok";
  moved = 0;
  list() {
    return this.conversations;
  }
  async startNew(options?: { worktree?: boolean }) {
    if (options?.worktree && this.worktreeError) return this.worktreeError;
    this.started.push(options);
    this.currentId = "conv-fresh";
    if (options?.worktree)
      this.conversations.push({ id: "conv-fresh", startedAt: at(40), updatedAt: at(40), sessions: {}, workDir: "C:\\dev\\app-1a2b", branch: "clodex/1a2b" });
    return undefined;
  }
  async moveCurrentToWorktree() {
    this.moved++;
    if (this.worktreeMove === "already") return { ok: false as const, reason: "already" as const };
    if (this.worktreeMove === "busy") return { ok: false as const, reason: "busy" as const, agents: "claude" };
    if (this.worktreeMove === "failed") return { ok: false as const, reason: "failed" as const, error: "git failed" };
    const worktree = { workDir: "C:\\dev\\app-1a2b", branch: "clodex/1a2b" };
    const current = this.conversations.find(c => c.id === this.currentId)!;
    current.workDir = worktree.workDir;
    current.branch = worktree.branch;
    return { ok: true as const, worktree };
  }
  readonly cleared: AgentId[] = [];
  clearSession(agent: AgentId) {
    this.cleared.push(agent);
  }
  readonly renamed: string[] = [];
  rename(title: string) {
    this.renamed.push(title);
  }
  readonly renamedById: Array<{ id: string; title: string }> = [];
  renameConversation(id: string, title: string) {
    this.renamedById.push({ id, title });
  }
  setSolo(mode: SoloMode | undefined) {
    const current = this.conversations.find(c => c.id === this.currentId);
    if (!current) return;
    if (mode) current.solo = mode;
    else delete current.solo;
  }
  readonly removed: string[] = [];
  remove(id: string) {
    if (id === this.currentId) return "cannot delete the current conversation";
    this.removed.push(id);
    return undefined;
  }
  togglePin(id: string) {
    const found = this.conversations.find(c => c.id === id);
    if (!found) return undefined;
    found.pinned = !found.pinned;
    return found.pinned;
  }
  async switchTo(id: string) {
    this.currentId = id;
    return this.conversations.find(c => c.id === id);
  }
}

class FakeCoordinator implements ShellCoordinator {
  questions = [{ id: "q1", agent: "claude" as const, questions: [{ question: "方針", options: [{ label: "A" }, { label: "B" }] }] }];
  answers: Array<{ id: string; value: unknown }> = [];
  answerError: string | undefined;
  pendingQuestions() {
    return this.questions;
  }
  answer(id: string, value: unknown) {
    this.answers.push({ id, value });
    return this.answerError;
  }
  readonly sent: Array<{ agent: AgentId; text: string }> = [];
  isIdle = true;
  idle() {
    return this.isIdle;
  }
  readonly interrupted: Array<AgentId | undefined> = [];
  readonly permissions: Array<{ level: PermissionLevel; agent: AgentId | undefined }> = [];
  readonly models: Array<{ model: string; agent: AgentId }> = [];
  readonly efforts: Array<{ level: string; agent: AgentId | undefined }> = [];
  settingResult: TurnResult | undefined;
  states: AgentState[] = [
    {
      id: "claude",
      status: "idle",
      sessionId: "s-claude",
      permission: "edit",
      model: "haiku",
      effort: "high",
      models: ["default", "opus", "sonnet", "haiku"].map(value => ({ value, label: value })),
      subagents: [],
      usage: {
        fiveHourPercent: 12,
        fiveHourResetsAt: new Date(2026, 9, 5, 22, 30).getTime() / 1000,
        weeklyPercent: 50,
        weeklyPace: -20,
        weeklyResetsAt: new Date(2026, 9, 9, 10, 0).getTime() / 1000,
        contextTokens: 85400,
        contextWindow: 200000,
      },
    },
    { id: "codex", status: "stopped", sessionId: undefined, permission: "full", models: [], usage: {}, subagents: [] },
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
  messages: PendingMessage[] = [];
  readonly canceled: Array<string | undefined> = [];
  pendingInputs() {
    return this.pending;
  }
  pendingMessages() {
    return this.messages;
  }
  cancelInput(id?: string) {
    this.canceled.push(id);
    return this.pending.find(p => p.id === (id ?? "in2")) ?? this.messages.find(message => message.id === id);
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
  readonly sharedFlags: boolean[] = [];
  async steerOrSend(agent: AgentId, text: string, context = false, shared = false): Promise<"steered" | "queued"> {
    this.steeredInputs.push({ agent, text });
    this.contexts.push(context);
    this.sharedFlags.push(shared);
    return "steered";
  }

  readonly images: Array<readonly string[] | undefined> = [];
  readonly contexts: boolean[] = [];
  sendToAgent(agent: AgentId, text: string, images?: readonly string[], context = false, shared = false): Promise<TurnResult> {
    this.sent.push({ agent, text });
    this.images.push(images);
    this.contexts.push(context);
    this.sharedFlags.push(shared);
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
  readonly finish: Array<(result: CommandResult) => void> = [];
  running = 0;
  stops = 0;
  run(command: string): Promise<CommandResult> {
    this.commands.push(command);
    // 終了を待たずに次の入力を受け付けることを確認する。終了はテストが finish で起こす
    return new Promise(resolve => this.finish.push(resolve));
  }
  stopAll(): number {
    this.stops++;
    const stopped = this.running;
    this.running = 0;
    return stopped;
  }
}

const setup = ({ withoutProject = false } = {}) => {
  const coordinator = new FakeCoordinator();
  const runner = new FakeRunner();
  const background = {
    starts: [] as string[],
    stops: 0,
    killed: [] as number[],
    entries: [] as ManagedProcess[],
    start(command: string) {
      this.starts.push(command);
      return this.starts.length;
    },
    async stopAll() {
      this.stops++;
    },
    kill(id: number) {
      this.killed.push(id);
      return id === 1;
    },
    list() {
      return this.entries;
    },
    output(id: number) {
      return id === 1 ? ["line one", "line two"] : undefined;
    },
  };
  const printed: string[] = [];
  const notified: string[] = [];
  const levels: Array<"info" | "warn" | undefined> = [];
  let verbose = false;
  const history = new FakeHistory();
  const busy = { value: false };
  const worktreeSetup: { value: string | undefined } = { value: undefined };
  const saved: Array<{ agents: readonly AgentId[]; change: object }> = [];
  const roles: Partial<Record<AgentId, string>> = { claude: "設計" };
  const references: string[] = [];
  let hasProject = !withoutProject;
  const tabUnpinned: Array<{ projectRoot: string; id: string }> = [];
  const projects = {
    list: () => [
      { projectRoot: "C:\\dev\\one", open: true, current: true, pinned: true },
      { projectRoot: "C:\\dev\\two", open: false, current: false, pinned: false },
    ],
    open: async (path: string) => {
      hasProject = true;
      return { projectRoot: path, primary: "codex" as AgentId };
    },
    togglePin: (path: string) => (path === "C:\\dev\\two" ? true : undefined),
    remove: (path: string) => (path === "C:\\dev\\two" ? undefined : path === "C:\\dev\\one" ? ("open" as const) : ("missing" as const)),
    findConversation: (projectRoot: string, id: string) => (projectRoot === "C:\\dev\\two" && id === "conv-old" ? history.conversations[1] : undefined),
    unpinConversation: (projectRoot: string, id: string) => {
      tabUnpinned.push({ projectRoot, id });
      return false;
    },
    hasCurrent: () => hasProject,
  };
  // 本物と同じく、project を開く前に会話を求めると例外にする
  const historyOf = () => {
    if (!hasProject) throw new Error("no project");
    return history;
  };
  let limits = { ...DEFAULT_LIMITS };
  let unlimited = false;
  let language: "ja" | "en" = "ja";
  const languages: string[] = [];
  let sandboxEnabled = false;
  const sandbox = {
    enabled: () => sandboxEnabled,
    ready: async () => true,
    set: async (enabled: boolean) => {
      sandboxEnabled = enabled;
    },
    uninstall: async () => {
      sandboxEnabled = false;
    },
  };
  const languageSettings = {
    get: () => language,
    set: (value: "ja" | "en") => {
      language = value;
      languages.push(value);
    },
  };
  const shell = createShell({
    sandbox,
    language: languageSettings,
    coordinator: () => coordinator,
    primary: "claude",
    notify: (text, level) => {
      notified.push(text);
      levels.push(level);
    },
    busyElsewhere: () => busy.value,
    print: line => printed.push(line),
    toggleVerbose: () => (verbose = !verbose),
    history: historyOf,
    runner,
    limits: {
      get: () => limits,
      unlimited: () => unlimited,
      set: (name, value) => {
        limits[LIMIT_KEYS[name]] = value;
        unlimited = false;
      },
      reset: () => {
        limits = { ...DEFAULT_LIMITS };
        unlimited = false;
      },
      setUnlimited: () => {
        unlimited = true;
      },
    },
    saveSettings: (agents, change) => saved.push({ agents, change }),
    resolveReference: async path => {
      references.push(path);
      return ({ "src/a.ts": "C:/p/src/a.ts", "shot.png": "C:/up/shot.png" } as Record<string, string>)[path];
    },
    projects,
    processes: background,
    roles: () => roles,
    worktreeSetup: () => worktreeSetup.value,
    saveRole: (agent, value) => {
      roles[agent] = value;
      return value;
    },
  });
  return {
    languageSettings,
    languages,
    coordinator,
    printed,
    notified,
    levels,
    shell,
    history,
    runner,
    saved,
    busy,
    worktreeSetup,
    projects,
    roles,
    background,
    references,
    sandbox,
    tabUnpinned,
  };
};

it("/language は現在値を表示し、正しい値だけ保存する", async () => {
  const { shell, languages, printed } = setup();
  await shell.handleLine("/language");
  expect(printed.at(-1)).toContain("ja");
  await shell.handleLine("/language en");
  await shell.handleLine("/language");
  expect(printed.at(-1)).toContain("en");
  await shell.handleLine("/language fr");
  await shell.handleLine("/language ja en");
  expect(languages).toEqual(["en"]);
  expect(printed.at(-1)).toContain("/language");
});

describe("createShell", () => {
  it("/tab で別 project の会話へ切り替え、無い会話なら project を開かない", async () => {
    const { shell, history, projects, notified, levels } = setup({ withoutProject: true });
    const opened: string[] = [];
    const originalOpen = projects.open;
    projects.open = async path => {
      opened.push(path);
      return originalOpen(path);
    };
    await shell.handleLine("/tab missing C:\\dev\\two");
    expect(opened).toEqual([]);
    expect(notified.at(-1)).toBe("conversation not found");
    expect(levels.at(-1)).toBe("warn");
    await shell.handleLine("/tab conv-old C:\\dev\\two");
    expect(opened).toEqual(["C:\\dev\\two"]);
    expect(history.currentId).toBe("conv-old");
    expect(notified.at(-1)).toBe('switched to: "Remember BANANA"');
  });

  it("/tab unpin は project を開かずに固定を外す", async () => {
    const { shell, projects, tabUnpinned, notified } = setup();
    const opened: string[] = [];
    const originalOpen = projects.open;
    projects.open = async path => {
      opened.push(path);
      return originalOpen(path);
    };
    await shell.handleLine("/tab unpin conv-old C:\\dev\\two");
    expect(tabUnpinned).toEqual([{ projectRoot: "C:\\dev\\two", id: "conv-old" }]);
    expect(opened).toEqual([]);
    expect(notified.at(-1)).toBe('unpinned: "Remember BANANA"');
  });
  it("Web の /sandbox on 失敗は表示し、入力 API は 204 を返す", async () => {
    const { shell, sandbox, printed } = setup();
    sandbox.set = async () => {
      throw new Error("Invalid runtime ACL");
    };
    const server = await startWebServer({
      port: 0,
      token: "test-token",
      feed: new WebFeed(),
      page: buildWebPage("en"),
      onInput: async line => {
        await shell.handleLine(line);
      },
      listFiles: async () => [],
      preview: { file: async () => ({ ok: false, status: 404, message: "" }), diff: async () => ({ ok: false, status: 404, message: "" }) },
      upload: { maxBytes: 0, accepts: () => false, save: async () => "" },
    });
    try {
      const response = await fetch(`${server.url}/api/input`, {
        method: "POST",
        headers: { cookie: "clodex_token=test-token" },
        body: JSON.stringify({ line: "/sandbox on" }),
      });
      expect(response.status).toBe(204);
      expect(printed.at(-1)).toContain("Invalid runtime ACL");
    } finally {
      await server.close();
    }
  });
  it.each(["/sandbox", "/sandbox on", "/sandbox off", "/sandbox uninstall"])("%s の失敗は表示し、入力処理を reject しない", async command => {
    const { shell, printed, sandbox } = setup();
    const failure = async () => {
      throw new Error("sandbox failed");
    };
    sandbox.ready = failure;
    sandbox.set = failure;
    sandbox.uninstall = failure;
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
    expect(coordinator.sharedFlags).toEqual([true, true]);
    expect(printed).toContain("@all: sent to claude and codex");
    expect(references).toEqual(["shot.png"]);
  });
  it("@all! は両 Agent に割り込む", async () => {
    const { shell, coordinator } = setup();
    await shell.handleLine("@all! hello");
    expect(coordinator.steeredInputs).toEqual(["claude", "codex"].map(agent => ({ agent, text: "[Sent to both claude and codex]\nhello" })));
    expect(coordinator.sharedFlags).toEqual([true, true]);
  });
  it("/role で役割を表示し、編集後に次の session の案内を出す", async () => {
    const { shell, printed, roles } = setup();
    await shell.handleLine("/role");
    expect(printed.join("\n")).toContain("設計");
    await shell.handleLine("/role codex 実装を担当");
    expect(roles.codex).toBe("実装を担当");
    expect(printed.at(-1)).toContain("/new codex");
  });
  it("/role preset が一覧を出し、選択時は両 Agent の役割を保存する", async () => {
    const { shell, printed, roles } = setup();
    await shell.handleLine("/role preset");
    expect(printed.join("\n")).toContain("design-review");
    expect(printed.join("\n")).toContain("Claude designs & reviews / Codex implements");
    await shell.handleLine("/role preset codex-design");
    expect(roles.claude).toContain("実装とコミットを担当する");
    expect(roles.codex).toContain("設計とレビューを担当する");
    expect(printed.at(-1)).toContain("/new codex");
  });
  it("/role preset の知らない名前はエラーにする", async () => {
    const { shell, printed, roles } = setup();
    await shell.handleLine("/role preset unknown");
    expect(printed.join("\n")).toContain("unknown");
    expect(roles).toEqual({ claude: "設計" });
  });
  it("/project で一覧を表示し、指定パスへ切り替える", async () => {
    const { shell, printed } = setup();
    await shell.handleLine("/project");
    expect(printed.join("\n")).toContain("C:\\dev\\one");
    expect(printed.join("\n")).toContain("C:\\dev\\two");
    await shell.handleLine("/project C:\\dev\\two");
    expect(shell.getPrimary()).toBe("codex");
  });
  it("/project pin と /project remove で一覧を整理し、結果を通知する", async () => {
    const { shell, printed, notified, levels } = setup();
    await shell.handleLine("/project");
    expect(printed.find(line => line.startsWith("C:\\dev\\one"))).toContain("(pinned)");
    for (const line of [
      "/project pin C:\\dev\\two",
      "/project pin C:\\dev\\x",
      "/project remove C:\\dev\\two",
      "/project remove C:\\dev\\one",
      "/project remove C:\\dev\\x",
    ]) {
      await shell.handleLine(line);
    }
    expect(notified).toEqual([
      "Pinned: C:\\dev\\two",
      "Not in the list: C:\\dev\\x",
      "Removed from list: C:\\dev\\two",
      "Open projects can't be removed: C:\\dev\\one",
      "Not in the list: C:\\dev\\x",
    ]);
    expect(levels.slice(-5)).toEqual([undefined, "warn", undefined, "warn", "warn"]);
  });
  it("送信はターン完了を待たずに戻る", async () => {
    const { coordinator, shell } = setup();
    await expect(shell.handleLine("hello")).resolves.toBe("continue");
    await expect(shell.handleLine("@codex review")).resolves.toBe("continue");
    expect(coordinator.sent).toEqual([
      { agent: "claude", text: "hello" },
      { agent: "codex", text: "review" },
    ]);
  });

  it("/context は会話本文の参照を依頼に添えて送る", async () => {
    const { coordinator, shell } = setup();
    await shell.handleLine("@codex /context 過去の判断に沿って回答して");
    expect(coordinator.sent).toHaveLength(1);
    expect(coordinator.sent[0]).toEqual({ agent: "codex", text: "過去の判断に沿って回答して" });
    expect(coordinator.contexts).toEqual([true]);
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

  it("!> は終わったら結果を送り先の Agent に送り、止めたときは送らない", async () => {
    const { coordinator, runner, shell } = setup();
    await expect(shell.handleLine("@codex !> pnpm test")).resolves.toBe("continue");
    expect(runner.commands).toEqual(["pnpm test"]);
    expect(coordinator.sent).toEqual([]);
    runner.finish[0]!({ code: 1, stopped: false, output: ["FAIL"] });
    await flush();
    expect(coordinator.sent).toHaveLength(1);
    expect(coordinator.sent[0]).toMatchObject({ agent: "codex", text: expect.stringContaining("FAIL") });
    await shell.handleLine("!> pnpm build");
    runner.finish[1]!({ code: null, stopped: true, output: [] });
    await flush();
    expect(coordinator.sent).toHaveLength(1);
    await shell.handleLine("!> pnpm lint");
    runner.finish[2]!({ code: 0, stopped: false, output: [] });
    await flush();
    expect(coordinator.sent[1]).toMatchObject({ agent: "claude" });
  });

  it("project を開く前でも /project を実行できる", async () => {
    const { shell, notified } = setup({ withoutProject: true });
    await expect(shell.handleLine("/project C:\\dev\\one")).resolves.toBe("continue");
    expect(notified.at(-1)).toContain("C:\\dev\\one");
  });

  it("会話の要否を handler の設定から判定する", async () => {
    const { shell, printed } = setup({ withoutProject: true });
    await shell.handleLine("/help");
    expect(printed.length).toBeGreaterThan(0);
    const before = printed.length;
    await shell.handleLine("/status");
    expect(printed).toHaveLength(before + 1);
    expect(printed.at(-1)).toContain("project");
  });

  it("/solo は作業中でなければ今の会話に保存し、作業中なら拒否する", async () => {
    const { coordinator, history, notified, shell } = setup();
    const solo = () => history.conversations.find(c => c.id === history.currentId)?.solo;
    await shell.handleLine("/solo");
    expect(solo()).toBe("free");
    await shell.handleLine("/solo codex");
    expect(solo()).toBe("codex");
    coordinator.isIdle = false;
    await shell.handleLine("/solo disable");
    expect(solo()).toBe("codex");
    expect(notified.at(-1)).toMatch(/作業中|working/);
    coordinator.isIdle = true;
    await shell.handleLine("/solo disable");
    expect(solo()).toBeUndefined();
  });

  it("送り先を固定した solo では、ほかの Agent への送信と @all を拒否する", async () => {
    const { coordinator, history, shell } = setup();
    history.setSolo("codex");
    await shell.handleLine("@claude 作業");
    await shell.handleLine("@all 作業");
    await shell.handleLine("@claude !> pnpm test");
    expect(coordinator.sent).toEqual([]);
    await shell.handleLine("@codex 作業");
    await shell.handleLine("作業");
    expect(coordinator.sent.map(s => s.agent)).toEqual(["codex", "codex"]);
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

  it("/status と /cancel に配送待ちの Agent 間メッセージを含める", async () => {
    const { coordinator, printed, shell } = setup();
    coordinator.messages = [{ id: "msg_1", agent: "codex", from: "claude", type: "DELEGATE", taskId: "T", text: "実装して\n詳細" }];
    await shell.handleLine("/status");
    expect(printed).toContain("queued: msg_1 claude -> codex DELEGATE: 実装して");
    await shell.handleLine("/cancel msg_1");
    expect(coordinator.canceled).toContain("msg_1");
    expect(printed.at(-1)).toBe("canceled: msg_1 -> codex");
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
    expect(coordinator.permissions).toEqual([
      { level: "read-only", agent: "codex" },
      { level: "full", agent: undefined },
    ]);
    expect(printed).toEqual(["permission: codex -> read-only", "permission: all agents -> full"]);
  });

  it("/model と /effort を Coordinator に渡す", async () => {
    const { coordinator, printed, shell } = setup();
    await shell.handleLine("/model claude haiku");
    await shell.handleLine("/effort codex low");
    await shell.handleLine("/effort high");
    expect(coordinator.models).toEqual([{ agent: "claude", model: "haiku" }]);
    expect(coordinator.efforts).toEqual([
      { agent: "codex", level: "low" },
      { agent: undefined, level: "high" },
    ]);
    expect(printed).toEqual(["Saved model: claude → haiku", "Saved effort: codex → low", "Saved effort: all agents → high"]);
  });

  it("設定ターンが failed のとき成功表示を出さず、保存もしない", async () => {
    const { coordinator, printed, notified, levels, shell, saved } = setup();
    coordinator.settingResult = { status: "failed", text: "Model not found" };
    await shell.handleLine("/model claude missing-model");
    await shell.handleLine("/effort claude high");
    expect(printed).toEqual([]);
    expect(notified).toEqual(["Model not found", "Model not found"]);
    expect(levels).toEqual(["warn", "warn"]);
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
    expect(notified).toEqual(['renamed: "設計の相談 その2"']);
    expect(printed).toEqual([]);
  });

  it("/rename #番号 はその会話の名前を変えて通知する", async () => {
    const { history, printed, notified, shell } = setup();
    await shell.handleLine("/rename #2 新しい名前");
    expect(history.renamedById).toEqual([{ id: "conv-old", title: "新しい名前" }]);
    expect(notified).toEqual(['renamed: "新しい名前"']);
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
    expect(notified).toEqual(["cannot delete the current conversation", 'deleted: "Remember BANANA"', 'pinned: "(no input)"', 'unpinned: "(no input)"']);
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
    expect(printed).toEqual(["Already open", "no conversation #9"]);
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
    const { history, notified, shell } = setup();
    await shell.handleLine("/new worktree");
    expect(history.started).toEqual([{ worktree: true }]);
    expect(notified).toEqual(["new conversation: worktree C:\\dev\\app-1a2b (clodex/1a2b)"]);
    history.worktreeError = "fatal: not a git repository";
    await shell.handleLine("/new worktree");
    expect(notified.at(-1)).toBe("could not create a worktree: fatal: not a git repository");
  });

  it("/new worktree で作れたら worktree.setup を !command と同じに実行する", async () => {
    const { history, runner, worktreeSetup, shell } = setup();
    await shell.handleLine("/new worktree");
    expect(runner.commands).toEqual([]);
    worktreeSetup.value = "pnpm install";
    await shell.handleLine("/new");
    expect(runner.commands).toEqual([]);
    await shell.handleLine("/new worktree");
    expect(runner.commands).toEqual(["pnpm install"]);
    history.worktreeError = "fatal: not a git repository";
    await shell.handleLine("/new worktree");
    expect(runner.commands).toEqual(["pnpm install"]);
  });
  it("/worktree は今の会話を移し、setup を新しい作業場所で実行する", async () => {
    const { history, runner, worktreeSetup, shell, notified } = setup();
    worktreeSetup.value = "pnpm install";
    await shell.handleLine("/worktree");
    expect(history.moved).toBe(1);
    expect(history.list().find(c => c.id === history.currentId)).toMatchObject({ workDir: "C:\\dev\\app-1a2b", branch: "clodex/1a2b" });
    expect(notified.at(-1)).toBe("worktree: C:\\dev\\app-1a2b (branch clodex/1a2b)");
    expect(runner.commands).toContain("pnpm install");
  });

  it("/worktree は worktree 済み・作業中・作成失敗を知らせ、setup を実行しない", async () => {
    for (const reason of ["already", "busy", "failed"] as const) {
      const { history, runner, shell, notified, levels } = setup();
      history.worktreeMove = reason;
      await shell.handleLine("/worktree");
      expect(history.list().find(c => c.id === history.currentId)?.workDir).toBeUndefined();
      expect(runner.commands).toEqual([]);
      expect(levels.at(-1)).toBe("warn");
      expect(notified.at(-1)).toBeTruthy();
    }
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
      { id: "claude", status: "busy", sessionId: "s1", permission: "edit", models: [], usage: {}, subagents: [] },
      { id: "codex", status: "idle", sessionId: "s2", permission: "edit", models: [], usage: {}, subagents: [] },
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

it.each(["/new", "/new worktree", "/resume 2", "/rename 名前", "/delete 1", "/delete 2", "/pin 2", "/project C:/dev/two"])(
  "%s の操作結果はログに入れない",
  async command => {
    const { shell, printed, notified } = setup();
    await shell.handleLine(command);
    expect(notified).toHaveLength(1);
    expect(printed).toEqual([]);
  },
);

it("/answer は JSON の回答と 1 問への自由記述を渡す", async () => {
  const { shell, coordinator, notified } = setup();
  await shell.handleLine('/answer q1 [["A"]]');
  await shell.handleLine("/answer q1 自由な回答");
  expect(coordinator.answers).toEqual([
    { id: "q1", value: [["A"]] },
    { id: "q1", value: [["自由な回答"]] },
  ]);
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

it("/limits の複数指定をすべて保存して 1 行で出す", async () => {
  const { shell, printed } = setup();
  await shell.handleLine("/limits unlimited");
  await shell.handleLine("/limits messages 16 reviews 5");
  expect(printed.at(-1)).toBe("limits: messages 16, reviews 5");
  await shell.handleLine("/limits");
  expect(printed.slice(-4)).toEqual(["messages 16 (default 8)", "reviews 5 (default 3)", "delegations 4", "depth 2"]);
});

it("/limits unlimited で無制限にし、/limits で無制限と表示する", async () => {
  const { shell, printed } = setup();
  await shell.handleLine("/limits unlimited");
  expect(printed.at(-1)).toBe("limits: unlimited");
  await shell.handleLine("/limits");
  expect(printed.at(-1)).toBe("limits: unlimited");
  await shell.handleLine("/limits reset");
  await shell.handleLine("/limits");
  expect(printed.at(-1)).toBe("depth 2");
});

it("/language の保存失敗は表示し、Web は 204 を返して言語を保持する", async () => {
  const { shell, languageSettings, printed } = setup();
  const path = "C:/home/.clodex/config.json";
  languageSettings.set = () => {
    throw new Error(`${path}: EACCES`);
  };
  const server = await startWebServer({
    port: 0,
    token: "test-token",
    feed: new WebFeed(),
    page: buildWebPage("en"),
    onInput: async line => {
      await shell.handleLine(line);
    },
    listFiles: async () => [],
    preview: { file: async () => ({ ok: false, status: 404, message: "" }), diff: async () => ({ ok: false, status: 404, message: "" }) },
    upload: { maxBytes: 0, accepts: () => false, save: async () => "" },
  });
  try {
    const response = await fetch(`${server.url}/api/input`, {
      method: "POST",
      headers: { cookie: "clodex_token=test-token" },
      body: JSON.stringify({ line: "/language en" }),
    });
    expect(response.status).toBe(204);
    expect(printed.at(-1)).toContain(path);
    expect(printed.at(-1)).toContain("EACCES");
    expect(languageSettings.get()).toBe("ja");
  } finally {
    await server.close();
  }
});
