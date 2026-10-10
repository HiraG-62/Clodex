import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { EMPTY_MODEL_CATALOG } from "../agents/startup-probe.js";
import { applyFeedItem, rebuildTimeline } from "../web/client/timeline.js";
import { WebFeed } from "../web/web-feed.js";
import { openProject, protectRecoverySave } from "./project-context.js";

it("既存の会話を worktree に移すと runtime と session を保って cwd と preview を切り替える", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-move-context-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: projectRoot });
  git("init", "-q");
  writeFileSync(join(projectRoot, "a.txt"), "committed");
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  writeFileSync(join(projectRoot, "a.txt"), "uncommitted");
  const claude = new FakeAgentAdapter("claude");
  const codex = new FakeAgentAdapter("codex");
  const context = await openProject({
    projectRoot,
    homeDir,
    args: { models: {}, resume: false, web: false, serve: false },
    language: "ja",
    printTerminal: () => {},
    notify: () => {},
    notifyAgent: () => {},
    displayMode: () => "normal",
    isCurrent: () => true,
    modelCatalog: EMPTY_MODEL_CATALOG,
    registerCoordinator: () => () => {},
    createAgents: () => ({ claude, codex }),
  });
  try {
    const runtime = context.workspace.current;
    await runtime.coordinator.start();
    const allow = vi.spyOn(context.sandbox, "allowWorktree");
    const result = await context.workspace.moveCurrentToWorktree();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(context.workspace.current).toBe(runtime);
    expect(runtime.workDir).toBe(result.worktree.workDir);
    expect(claude.starts.at(-1)).toMatchObject({ cwd: result.worktree.workDir, resumeSessionId: "claude-session" });
    expect(codex.starts.at(-1)).toMatchObject({ cwd: result.worktree.workDir, resumeSessionId: "codex-session" });
    expect(allow).toHaveBeenCalledWith(result.worktree.workDir);
    expect(context.history.current).toMatchObject(result.worktree);
    const preview = await context.currentPreview().file("a.txt");
    expect(preview.ok && preview.body.toString()).toBe("committed");
  } finally {
    await context.close();
  }
});

it("復旧状態の保存失敗を呼び出し元へ出さず、連続失敗は一度だけ報告する", () => {
  const save = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error("disk busy");
    })
    .mockImplementationOnce(() => {
      throw new Error("disk busy");
    })
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error("disk busy again");
    });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const protectedSave = protectRecoverySave(save);
    expect(() => {
      protectedSave();
      protectedSave();
      protectedSave();
      protectedSave();
    }).not.toThrow();
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenNthCalledWith(1, "recovery save failed: disk busy\n");
    expect(stderr).toHaveBeenNthCalledWith(2, "recovery save failed: disk busy again\n");
  } finally {
    stderr.mockRestore();
  }
});

it("別 project のターン終了を共有の通知先へ渡す", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-other-project-"));
  const projectRoot = join(homeDir, "other-project");
  mkdirSync(projectRoot);
  const notifyAgent = vi.fn();
  const context = await openProject({
    projectRoot,
    homeDir,
    args: { models: {}, resume: false, web: false, serve: false },
    language: "ja",
    printTerminal: () => {},
    notify: () => {},
    notifyAgent,
    displayMode: () => "normal",
    isCurrent: () => false,
    modelCatalog: EMPTY_MODEL_CATALOG,
    registerCoordinator: () => () => {},
    createAgents: () => ({ claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") }),
  });
  try {
    context.workspace.current.bus.publish({ kind: "agent", agent: "claude", event: { type: "turn", result: { status: "completed", text: "完了" } } });
    expect(notifyAgent).toHaveBeenCalledWith(expect.objectContaining({ projectRoot, kind: "reply", agent: "claude" }));
    context.workspace.current.bus.publish({ kind: "question", id: "q1", agent: "codex", questions: [{ question: "方針は", options: [{ label: "A" }] }] });
    expect(notifyAgent).toHaveBeenCalledWith(expect.objectContaining({ projectRoot, kind: "question", agent: "codex" }));
  } finally {
    await context.close();
  }
});

it("言語変更で session を作り直さず、次の session の system prompt に反映する", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-language-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  let language: "ja" | "en" = "ja";
  const agents: FakeAgentAdapter[] = [];
  const context = await openProject({
    projectRoot,
    homeDir,
    args: { models: {}, resume: false, web: false, serve: false },
    language: () => language,
    printTerminal: () => {},
    notify: () => {},
    notifyAgent: () => {},
    displayMode: () => "normal",
    isCurrent: () => true,
    modelCatalog: EMPTY_MODEL_CATALOG,
    registerCoordinator: () => () => {},
    sandboxPlatform: {
      inspect: async () => false,
      connect: async () => {},
      grant: async () => {},
      release: async () => {},
      close: async () => {},
      spawn: vi.fn(),
    },
    createAgents: () => {
      const claude = new FakeAgentAdapter("claude");
      agents.push(claude);
      return { claude, codex: new FakeAgentAdapter("codex") };
    },
  });
  try {
    void context.workspace.current.coordinator.sendToAgent("claude", "最初");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(agents[0]!.starts[0]?.instructions).toContain("Japanese");
    language = "en";
    expect(agents[0]!.starts).toHaveLength(1);
    agents[0]!.completeTurn();
    await context.workspace.startNew();
    void context.workspace.current.coordinator.sendToAgent("claude", "次");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(agents[1]!.starts[0]?.instructions).toContain("English");
    agents[1]!.completeTurn();
  } finally {
    await context.close();
  }
});

it("起動中・作業中の会話に戻ってもターンを中断せず、完了を一つのターンにまとめる", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-project-feed-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  const agents: FakeAgentAdapter[] = [];
  const context = await openProject({
    projectRoot,
    homeDir,
    args: { models: {}, resume: false, web: false, serve: false },
    language: "en",
    printTerminal: () => {},
    notify: () => {},
    notifyAgent: () => {},
    displayMode: () => "normal",
    isCurrent: () => true,
    modelCatalog: EMPTY_MODEL_CATALOG,
    registerCoordinator: () => () => {},
    createAgents: () => {
      const claude = new FakeAgentAdapter("claude");
      agents.push(claude);
      return { claude, codex: new FakeAgentAdapter("codex") };
    },
  });
  try {
    const feed = new WebFeed();
    context.bindFeed(feed, () => true);
    const id = context.history.currentId;
    void context.workspace.current.coordinator.sendToAgent("claude", "作業");
    context.feedStore.append(id, {
      type: "event",
      seq: 1,
      event: { kind: "agent", agent: "claude", at: "2026-10-05T12:00:00Z", event: { type: "turn_started" } },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    agents[0]!.status = "starting";
    context.showFeed(feed);
    expect(feed.recent()).toHaveLength(1);
    agents[0]!.status = "busy";
    await context.workspace.startNew();
    await context.workspace.switchTo(id);
    expect(feed.recent()).toHaveLength(1);
    context.showFeed(feed);
    expect(feed.recent()).toHaveLength(1);
    feed.publishEvent({ kind: "agent", agent: "claude", at: "2026-10-05T12:00:01Z", event: { type: "turn", result: { status: "completed", text: "完了" } } });
    const timeline = rebuildTimeline(feed.recent(), applyFeedItem);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "turn", status: "completed", text: "完了" });
  } finally {
    await context.close();
  }
});

it("project の上限を保存し、既存・新規の会話と再起動に反映する", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-limits-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, ".clodex.json"), JSON.stringify({ limits: { maxMessagesPerChain: 12 } }));
  const open = () =>
    openProject({
      projectRoot,
      homeDir,
      args: { models: {}, resume: false, web: false, serve: false },
      language: "en",
      printTerminal: () => {},
      notify: () => {},
      notifyAgent: () => {},
      displayMode: () => "normal",
      isCurrent: () => true,
      modelCatalog: EMPTY_MODEL_CATALOG,
      registerCoordinator: () => () => {},
      createAgents: () => ({ claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") }),
    });
  let context = await open();
  try {
    expect(context.limits.maxMessagesPerChain).toBe(12);
    expect(context.limits.maxDelegationDepth).toBe(2);
    const first = vi.spyOn(context.workspace.current.coordinator, "setLimits");
    await context.workspace.startNew();
    const second = vi.spyOn(context.workspace.current.coordinator, "setLimits");
    context.setLimit("messages", 1);
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ maxMessagesPerChain: 1 }));
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ maxMessagesPerChain: 1 }));
    expect(context.settingsStore.load().limits).toEqual({ maxMessagesPerChain: 1 });
    await context.workspace.startNew();
    const coordinator = context.workspace.current.coordinator;
    expect(coordinator.receiveMessage("claude", { to: "codex", type: "QUESTION", taskId: "limit", body: "question" }).ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(coordinator.receiveMessage("codex", { to: "claude", type: "ISSUE", taskId: "limit", body: "reply" }).ok).toBe(false);
    await context.close();
    context = await open();
    expect(context.limits.maxMessagesPerChain).toBe(1);
    context.resetLimits();
    expect(context.limits.maxMessagesPerChain).toBe(12);
    expect(context.settingsStore.load().limits).toBeUndefined();
    const applied = vi.spyOn(context.workspace.current.coordinator, "setLimits");
    context.setUnlimited();
    expect(context.unlimited).toBe(true);
    expect(applied).toHaveBeenLastCalledWith({
      maxMessagesPerChain: Infinity,
      maxReviewRoundsPerChain: Infinity,
      maxDelegationsPerChain: Infinity,
      maxDelegationDepth: Infinity,
    });
    await context.close();
    context = await open();
    expect(context.unlimited).toBe(true);
    context.setLimit("messages", 5);
    expect(context.unlimited).toBe(false);
    expect(context.limits.maxMessagesPerChain).toBe(5);
    context.setUnlimited();
    context.resetLimits();
    expect(context.unlimited).toBe(false);
    expect(context.settingsStore.load().limitsUnlimited).toBeUndefined();
  } finally {
    await context.close();
  }
});

it("sandbox off の project を開いても実機の検査や broker 接続をしない", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-no-sandbox-probe-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  const ready = vi.fn(async () => false);
  const inspect = vi.fn(async () => false);
  const connect = vi.fn(async () => {});
  const context = await openProject({
    projectRoot,
    homeDir,
    args: { models: {}, resume: false, web: false, serve: false },
    language: "ja",
    printTerminal: () => {},
    notify: () => {},
    notifyAgent: () => {},
    displayMode: () => "normal",
    isCurrent: () => true,
    modelCatalog: EMPTY_MODEL_CATALOG,
    registerCoordinator: () => () => {},
    sandboxPlatform: {
      ready,
      inspect,
      connect,
      setupRecorded: () => true,
      grant: async () => {},
      release: async () => {},
      close: async () => {},
      spawn: vi.fn(),
    },
    createAgents: () => ({ claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") }),
  });
  try {
    expect(ready).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(context.sandbox.setupReady).toBe(true);
  } finally {
    await context.close();
  }
});
