import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import type { ModelCatalog, StartupProbe } from "../agents/startup-probe.js";
import { openProject } from "./project-context.js";

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const OLD_MODELS: ModelCatalog = {
  claude: [{ value: "fable", label: "Fable" }],
  codex: [{ value: "codex-old", label: "Codex old" }],
  gemini: [],
};
const NEW_MODELS: ModelCatalog = {
  claude: [
    { value: "fable-5.1", label: "Fable 5.1" },
    { value: "fable-5", label: "Fable 5" },
  ],
  codex: [{ value: "codex-new", label: "Codex new" }],
  gemini: [],
};

const pendingProbe = () => {
  let resolve!: (result: StartupProbe) => void;
  const promise = new Promise<StartupProbe>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

const setup = async (startupProbe = vi.fn(async (): Promise<StartupProbe> => ({ models: NEW_MODELS, usage: {} }))) => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-model-refresh-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  let now = 0;
  const agents: Array<Record<"claude" | "codex", FakeAgentAdapter>> = [];
  const notify = vi.fn();
  const onModelsChanged = vi.fn();
  const context = await openProject({
    projectRoot,
    homeDir,
    args: { models: {}, resume: false, web: false, serve: false },
    language: "ja",
    printTerminal: () => {},
    notify,
    notifyAgent: () => {},
    displayMode: () => "normal",
    isCurrent: () => true,
    modelCatalog: () => OLD_MODELS,
    registerCoordinator: () => () => {},
    startupProbe,
    now: () => now,
    onModelsChanged,
    createAgents: () => {
      const created = { claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex"), gemini: new FakeAgentAdapter("gemini") };
      agents.push(created);
      return created;
    },
    sandboxPlatform: {
      inspect: async () => true,
      connect: async () => {},
      grant: async () => {},
      release: async () => {},
      close: async () => {},
      spawn: vi.fn(),
    },
  });
  return { context, agents, startupProbe, notify, onModelsChanged, advance: (ms: number) => (now += ms) };
};

it("Agent 起動時の一覧取得を待たずに起動し、取得中は 10 分後も重複取得しない", async () => {
  const pending = pendingProbe();
  const { context, startupProbe, advance, onModelsChanged } = await setup(vi.fn(() => pending.promise));
  try {
    const coordinator = context.workspace.current.coordinator;
    await coordinator.start();
    expect(coordinator.status().map(agent => agent.status)).toEqual(["idle", "idle", "idle"]);
    expect(startupProbe).toHaveBeenCalledTimes(1);
    expect(onModelsChanged).not.toHaveBeenCalled();
    expect(coordinator.status().map(agent => agent.models)).toEqual([OLD_MODELS.claude, OLD_MODELS.codex, OLD_MODELS.gemini]);
    advance(REFRESH_INTERVAL_MS + 1);
    await coordinator.switchSessions({}, ["codex"]);
    await coordinator.start();
    expect(startupProbe).toHaveBeenCalledTimes(1);
    pending.resolve({ models: NEW_MODELS, usage: {} });
    await context.probe();
    expect(coordinator.status().map(agent => agent.models)).toEqual([NEW_MODELS.claude, NEW_MODELS.codex, NEW_MODELS.gemini]);
    expect(onModelsChanged).toHaveBeenCalledTimes(1);
  } finally {
    pending.resolve({ models: NEW_MODELS, usage: {} });
    await context.close();
  }
});

it("project 初回取得から 10 分以内の起動を抑制し、経過後は別会話の起動でも更新する", async () => {
  const { context, startupProbe, advance } = await setup();
  try {
    await context.probe();
    await context.workspace.current.coordinator.start();
    advance(REFRESH_INTERVAL_MS - 1);
    await context.workspace.current.coordinator.switchSessions({}, ["claude"]);
    await context.workspace.current.coordinator.start();
    expect(startupProbe).toHaveBeenCalledTimes(1);
    advance(2);
    startupProbe.mockResolvedValue({ models: OLD_MODELS, usage: {} });
    await context.workspace.startNew();
    await context.workspace.current.coordinator.start();
    expect(startupProbe).toHaveBeenCalledTimes(2);
    for (const runtime of context.workspace.allRuntimes()) expect(runtime.coordinator.status()[0]?.models).toEqual(OLD_MODELS.claude);
  } finally {
    await context.close();
  }
});

it.each(["claude", "codex"] as const)("取得が空の %s は前の一覧を保持する", async failed => {
  const models = { ...NEW_MODELS, [failed]: [] };
  const { context } = await setup(vi.fn(async () => ({ models, usage: {} })));
  try {
    await context.workspace.current.coordinator.start();
    for (const agent of context.workspace.current.coordinator.status()) {
      expect(agent.models).toEqual(agent.id === failed ? OLD_MODELS[agent.id] : NEW_MODELS[agent.id]);
    }
  } finally {
    await context.close();
  }
});

it("取得全体の失敗も起動を止めず、開始から 10 分は再取得しない", async () => {
  const startupProbe = vi.fn(async (): Promise<StartupProbe> => {
    throw new Error("probe failed");
  });
  const { context, advance, notify } = await setup(startupProbe);
  try {
    await context.workspace.current.coordinator.start();
    expect(notify).toHaveBeenCalledWith("probe failed", "warn");
    advance(REFRESH_INTERVAL_MS - 1);
    await context.workspace.current.coordinator.switchSessions({}, ["codex"]);
    await context.workspace.current.coordinator.start();
    expect(startupProbe).toHaveBeenCalledTimes(1);
    expect(context.workspace.current.coordinator.status()[0]?.models).toEqual(OLD_MODELS.claude);
    advance(2);
    await context.workspace.current.coordinator.switchSessions({}, ["codex"]);
    await context.workspace.current.coordinator.start();
    expect(startupProbe).toHaveBeenCalledTimes(2);
  } finally {
    await context.close();
  }
});

it("sandbox 切替は即座に再取得し、旧世代の完了は一覧や新世代の取得中状態を変えない", async () => {
  const previous = pendingProbe();
  const current = pendingProbe();
  const { context, startupProbe, advance, onModelsChanged } = await setup(vi.fn(() => current.promise).mockImplementationOnce(() => previous.promise));
  try {
    const probe = context.probe();
    await context.sandbox.setEnabled(true);
    expect(startupProbe).toHaveBeenCalledTimes(2);
    previous.resolve({ models: NEW_MODELS, usage: {} });
    await probe;
    expect(context.workspace.current.coordinator.status()[0]?.models).toEqual(OLD_MODELS.claude);
    expect(onModelsChanged).not.toHaveBeenCalled();
    advance(REFRESH_INTERVAL_MS + 1);
    await context.workspace.current.coordinator.switchSessions({}, ["codex"]);
    await context.workspace.current.coordinator.start();
    expect(startupProbe).toHaveBeenCalledTimes(2);
    current.resolve({ models: NEW_MODELS, usage: {} });
    await context.probe();
    expect(context.workspace.current.coordinator.status()[0]?.models).toEqual(NEW_MODELS.claude);
    expect(onModelsChanged).toHaveBeenCalledTimes(1);
  } finally {
    previous.resolve({ models: NEW_MODELS, usage: {} });
    current.resolve({ models: NEW_MODELS, usage: {} });
    await context.close();
  }
});

it.each(["claude", "codex"] as const)("%s の resume と fresh の起動で更新し、稼働中の起動要求では更新しない", async agent => {
  const { context, agents, startupProbe, advance } = await setup();
  try {
    const coordinator = context.workspace.current.coordinator;
    await coordinator.start();
    advance(REFRESH_INTERVAL_MS + 1);
    await coordinator.start();
    expect(startupProbe).toHaveBeenCalledTimes(1);
    await coordinator.switchSessions({ [agent]: "saved-session" }, [agent]);
    await coordinator.start();
    expect(agents[0]![agent].starts.at(-1)?.resumeSessionId).toBe("saved-session");
    expect(startupProbe).toHaveBeenCalledTimes(2);
    advance(REFRESH_INTERVAL_MS + 1);
    const received = coordinator.receiveMessage(agent === "claude" ? "codex" : "claude", {
      to: agent,
      type: "DELEGATE",
      taskId: "refresh",
      body: "一覧更新の検証",
      fresh: true,
    });
    expect(received.ok).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(startupProbe).toHaveBeenCalledTimes(3);
    expect(agents[0]![agent].starts.at(-1)?.resumeSessionId).toBeUndefined();
    agents[0]![agent].completeTurn({ status: "completed", text: "" });
  } finally {
    await context.close();
  }
});

it("並列の子会話の起動でも一覧を更新する", async () => {
  const { context, startupProbe, advance } = await setup();
  try {
    await context.probe();
    advance(REFRESH_INTERVAL_MS + 1);
    const child = await context.workspace.startParallel(context.history.currentId, {
      id: "parallel-refresh",
      from: "claude",
      to: "codex",
      type: "DELEGATE",
      taskId: "refresh",
      body: "並列起動",
      repository: context.projectRoot,
      createdAt: new Date().toISOString(),
    });
    if ("error" in child) throw new Error(child.error);
    const runtime = context.workspace.allRuntimes().find(entry => entry.conversationId === child.thread)!;
    await runtime.coordinator.start();
    expect(startupProbe).toHaveBeenCalledTimes(2);
    expect(runtime.coordinator.status()[0]?.models).toEqual(NEW_MODELS.claude);
  } finally {
    await context.close();
  }
});
