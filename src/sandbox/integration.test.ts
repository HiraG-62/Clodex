import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { EMPTY_MODEL_CATALOG } from "../agents/startup-probe.js";
import { parseInput } from "../cli/input.js";
import { openProject } from "../hub/project-context.js";
import type { SandboxPlatform } from "./controller.js";
import { validateSandboxPath } from "./windows-platform.js";

it("/sandbox の引数を検証する", () => {
  expect(parseInput("/sandbox", "claude")).toEqual({ kind: "sandbox" });
  for (const action of ["on", "off", "uninstall"]) expect(parseInput(`/sandbox ${action}`, "claude")).toEqual({ kind: "sandbox", action });
  for (const action of ["ON", "on off", "reset"]) expect(parseInput(`/sandbox ${action}`, "claude").kind).toBe("invalid");
});

it("ドライブ全体・home 全体・その祖先へ Modify を付けない", () => {
  for (const path of ["E:\\", "C:\\Users", "C:\\Users\\human", "relative"]) expect(() => validateSandboxPath(path, "C:\\Users\\human")).toThrow();
  expect(() => validateSandboxPath("E:\\dev\\project", "C:\\Users\\human")).not.toThrow();
  for (const path of ["C:\\Users\\human\\.clodex", "C:\\Users\\human\\.clodex\\artifacts\\project", "C:\\Users\\human\\AppData\\Local\\project"])
    expect(() => validateSandboxPath(path, "C:\\Users\\human")).toThrow();
  expect(() => validateSandboxPath("C:\\Users\\human\\.clodex\\artifacts\\project", "C:\\Users\\human", true)).not.toThrow();
  expect(() => validateSandboxPath("C:\\Users\\human\\.clodex\\state", "C:\\Users\\human", true)).toThrow();
});

it("全会話を新規 session にし、履歴を残して permission と保存設定を復帰する", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-sandbox-unit-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, ".clodex.json"), JSON.stringify({ permission: "read-only" }));
  const adapters: FakeAgentAdapter[] = [];
  const platform: SandboxPlatform = {
    inspect: vi.fn(async () => true),
    connect: vi.fn(async () => {}),
    grant: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    spawn: vi.fn(),
  };
  const probe = vi.fn(async () => ({ models: EMPTY_MODEL_CATALOG(), usage: {} }));
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
    sandboxPlatform: platform,
    startupProbe: probe,
    createAgents: () => {
      const agents = { claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") };
      adapters.push(agents.claude, agents.codex);
      return agents;
    },
  });
  try {
    context.history.rename("以前の会話");
    const firstId = context.history.currentId;
    context.workspace.current.bus.publish({ kind: "agent", agent: "claude", event: { type: "session", sessionId: "human-session" } });
    await context.workspace.startNew();
    context.history.rename("今の会話");
    context.settingsStore.update(["codex"], { permission: "edit" });
    await context.sandbox.setEnabled(true);
    expect(context.settingsStore.load()).toMatchObject({ sandbox: true, codex: { permission: "edit" } });
    expect(context.history.list().map(c => c.title)).toEqual(expect.arrayContaining(["以前の会話", "今の会話"]));
    expect(context.history.list().every(c => Object.keys(c.sessions).length === 0)).toBe(true);
    for (const runtime of context.workspace.allRuntimes()) {
      expect(runtime.coordinator.status().map(agent => agent.permission)).toEqual(["full", "full"]);
      await expect(runtime.coordinator.setPermission("edit")).rejects.toThrow();
    }
    expect(adapters.slice(0, 4).every(agent => agent.status === "stopped")).toBe(true);
    expect(adapters.slice(4).every(agent => agent.starts.length === 1 && !agent.starts[0]?.resumeSessionId)).toBe(true);
    await context.workspace.switchTo(firstId);
    expect(context.workspace.current.coordinator.status()[0]?.permission).toBe("full");
    await context.sandbox.setEnabled(false);
    expect(context.settingsStore.load().sandbox).toBe(false);
    expect(context.workspace.current.coordinator.status().map(agent => agent.permission)).toEqual(["read-only", "edit"]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(platform.release).toHaveBeenCalledTimes(1);
    context.history.startNew({ workDir: join(homeDir, "deleted-worktree"), branch: "deleted" });
    await context.workspace.switchTo(context.history.currentId);
    await context.sandbox.setEnabled(true);
    await context.sandbox.setEnabled(false);
    expect(context.settingsStore.load().sandbox).toBe(false);
    expect(context.workspace.current.coordinator.status().every(agent => agent.status === "stopped")).toBe(true);
  } finally {
    await context.close();
  }
});

it("保存済み on の初期化失敗でも project を開き、off に復帰できる", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-sandbox-failed-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, ".clodex.json"), JSON.stringify({ sandbox: true }));
  const notify = vi.fn();
  const platform: SandboxPlatform = { inspect: async () => false, connect: vi.fn(), grant: vi.fn(), release: vi.fn(), close: vi.fn(), spawn: vi.fn() };
  const agents = { claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") };
  const context = await openProject({
    projectRoot,
    homeDir,
    args: { models: {}, resume: false, web: false, serve: false },
    language: "en",
    printTerminal: () => {},
    notify,
    notifyAgent: () => {},
    displayMode: () => "normal",
    isCurrent: () => true,
    modelCatalog: EMPTY_MODEL_CATALOG,
    registerCoordinator: () => () => {},
    sandboxPlatform: platform,
    createAgents: () => agents,
  });
  try {
    expect(notify).toHaveBeenCalled();
    expect(context.workspace.current.coordinator.status()).toHaveLength(2);
    await expect(context.workspace.current.coordinator.start()).rejects.toThrow();
    expect(agents.claude.starts).toHaveLength(0);
    await context.sandbox.setEnabled(false);
    expect(context.sandbox.enabled).toBe(false);
    expect(agents.claude.starts).toHaveLength(1);
  } finally {
    await context.close();
  }
});
