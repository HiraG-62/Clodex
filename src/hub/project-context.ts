// project ごとの設定・会話・Agent・保存をまとめる（DESIGN.md §28 D2a）
import { SandboxController, type SandboxPlatform } from "../sandbox/controller.js";
import { t } from "../i18n/i18n.js";
import { WindowsSandboxPlatform } from "../sandbox/windows-platform.js";
import { spawnAgentProcess, type SpawnAgentProcess } from "../agents/agent-process.js";
import { fetchStartupProbe, type StartupProbe } from "../agents/startup-probe.js";
import { mkdirSync } from "node:fs";
import type { AgentAdapter, AgentId } from "../agents/agent-adapter.js";
import { ClaudeAdapter } from "../agents/claude-adapter.js";
import { CodexAdapter } from "../agents/codex-adapter.js";
import type { ModelCatalog } from "../agents/startup-probe.js";
import type { CliArgs } from "../cli/args.js";
import { loadConfig, type ClodexConfig } from "../config/config.js";
import type { Language } from "../context/language.js";
import { buildRoleInstructions } from "../context/role-instructions.js";
import { DEFAULT_LIMITS, LIMIT_KEYS, type BudgetLimits, type LimitName } from "../coordinator/budget-manager.js";
import { Coordinator } from "../coordinator/coordinator.js";
import { EventBus } from "../coordinator/event-bus.js";
import { Workspace, type ConversationRuntime } from "./workspace.js";
import { attachEventLog, defaultLogPath, type DisplayMode } from "../logging/event-log.js";
import { startMcpServer } from "../mcp/server.js";
import { AgentSettingsStore, agentSettingsPath, resolveStartSettings, type SavedAgentSettings } from "../project/agent-settings.js";
import { ConversationHistory, conversationStatePath, type Conversation, type SavedSessions } from "../project/conversation-history.js";
import { hasRecoveryWork, loadRecovery, saveRecovery } from "../project/recovery-store.js";
import { artifactsDirPath, createFilePreview, uploadsDirPath } from "../project/file-preview.js";
import { createWorktree } from "../project/worktree.js";
import { connectConversationFeed } from "../web/conversation-feed.js";
import { FeedStore, feedDirPath } from "../web/feed-store.js";
import type { HistoryItem, WebFeed } from "../web/web-feed.js";

const LOG_SUFFIX_LENGTH = 8;
const DEFAULT_PRIMARY: AgentId = "claude";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface ProjectContext {
  readonly sandbox: SandboxController;
  probe(): Promise<void>;
  projectRoot: string;
  config: ClodexConfig;
  primary: AgentId;
  history: ConversationHistory;
  workspace: Workspace;
  settingsStore: AgentSettingsStore;
  feedStore: FeedStore;
  artifactsDir: string;
  uploadsDir: string;
  resumedSessions: SavedSessions;
  savedSettings: SavedAgentSettings;
  startedAt: Date;
  readonly limits: BudgetLimits;
  setLimit(name: LimitName, value: number): void;
  resetLimits(): void;
  currentPreview(): ReturnType<typeof createFilePreview>;
  saveFeedItem(conversationId: string, item: HistoryItem): void;
  bindFeed(feed: WebFeed, isCurrent: () => boolean): void;
  showFeed(feed: WebFeed): void;
  restore(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenProjectOptions {
  projectRoot: string;
  homeDir: string;
  args: CliArgs;
  language: Language | (() => Language);
  notify(text: string, level: "info" | "warn"): void;
  printTerminal(line: string): void;
  displayMode(): DisplayMode;
  isCurrent(): boolean;
  modelCatalog(): ModelCatalog;
  registerCoordinator(coordinator: Coordinator): () => void;
  createAgents?: () => Record<AgentId, AgentAdapter>;
  sandboxPlatform?: SandboxPlatform;
  startupProbe?: (cwd: string, spawn: SpawnAgentProcess) => Promise<StartupProbe>;
}

export const openProject = async ({
  projectRoot, homeDir, args, language, printTerminal, notify, displayMode, isCurrent, modelCatalog, registerCoordinator, createAgents, sandboxPlatform, startupProbe,
}: OpenProjectOptions): Promise<ProjectContext> => {
  const config = loadConfig({ homeDir, projectRoot });
  const primary = args.primary ?? config.primary ?? DEFAULT_PRIMARY;
  const statePath = conversationStatePath(homeDir, projectRoot);
  const recovery = loadRecovery(homeDir, projectRoot);
  const hasWork = recovery !== undefined && Object.values(recovery.conversations).some(hasRecoveryWork);
  const artifactsDir = artifactsDirPath(homeDir, statePath);
  mkdirSync(artifactsDir, { recursive: true });
  const uploadsDir = uploadsDirPath(homeDir, statePath);
  const history = new ConversationHistory(statePath, {
    resumeLatest: args.resume && !hasWork && !args.serve,
    ...((hasWork || args.serve) && recovery ? { resumeId: recovery.current } : {}),
  });
  const resumedSessions = history.currentSessions;
  const settingsStore = new AgentSettingsStore(agentSettingsPath(statePath));
  const savedSettings = settingsStore.load();
  const baseLimits = { ...DEFAULT_LIMITS, ...config.limits };
  let overrides = { ...savedSettings.limits };
  let limits = { ...baseLimits, ...overrides };
  const startedAt = new Date();
  let workspace: Workspace | undefined;
  const registered = new Map<Coordinator, () => void>();
  let catalog = modelCatalog();
  let generation = 0;
  const spawn: SpawnAgentProcess = (command, parameters, options) =>
    { if (!sandbox.usable) throw new Error(t("sandbox.incomplete")); return (sandbox.enabled ? sandbox.platform.spawn : spawnAgentProcess)(command, parameters, options); };
  const probe = async () => {
    if (!sandbox.usable) return;
    const current = generation;
    const fetch = startupProbe ?? (createAgents ? undefined : fetchStartupProbe);
    if (!fetch) return;
    const result = await fetch(projectRoot, spawn);
    if (current !== generation) return;
    catalog = result.models;
    for (const runtime of workspace?.allRuntimes() ?? []) runtime.coordinator.applyStartupUsage(result.usage);
  };
  const sandbox = new SandboxController(sandboxPlatform ?? new WindowsSandboxPlatform(homeDir, projectRoot, (text) => notify(text, "warn")), {
    notify: (text) => notify(text, "warn"),
    paths: () => ({ projects: [projectRoot, ...history.list().flatMap((conversation) => conversation.workDir ? [conversation.workDir] : [])], artifacts: artifactsDir }),
    stop: async () => { generation++; await workspace?.closeAll(); },
    save: (enabled) => { settingsStore.setSandbox(enabled); history.clearAllSessions(); saveRecovery(homeDir, projectRoot, { current: history.currentId, conversations: {} }); },
    restart: async () => { await workspace?.restart(); await probe(); },
  });
  if (savedSettings.sandbox ?? config.sandbox ?? false) await sandbox.initialize();

  const createRuntime = async (conversation: Conversation): Promise<ConversationRuntime> => {
    const bus = new EventBus();
    const workDir = conversation.workDir ?? projectRoot;
    await sandbox.allowWorktree(workDir);
    let coordinator: Coordinator | undefined;
    const mcp = await startMcpServer({ sendMessage: (from, input) => coordinator!.receiveMessage(from, input), askUser: (from, input) => coordinator!.askUser(from, input) });
    coordinator = new Coordinator({
      projectRoot: workDir,
      agents: createAgents?.() ?? { claude: new ClaudeAdapter(spawn), codex: new CodexAdapter(spawn) },
      permissionLocked: () => sandbox.enabled,
      canStart: () => sandbox.usable,
      bus,
      modelCatalog: () => catalog,
      mcpUrlFor: (agent) => mcp.urlFor(agent),
      settings: resolveStartSettings({
        saved: sandbox.enabled ? { ...settingsStore.load(), claude: { ...settingsStore.load().claude, permission: "full" }, codex: { ...settingsStore.load().codex, permission: "full" } } : settingsStore.load(), models: args.models, ...(config.permission ? { configPermission: config.permission } : {}),
      }),
      instructions: (id) => buildRoleInstructions(id, config.roles, { language: typeof language === "function" ? language() : language, artifactsDir }),
      limits,
      ...(config.usageAlert ? { usageAlert: config.usageAlert } : {}),
      resumeSessionIds: conversation.sessions,
      language,
    });
    attachEventLog(bus, {
      path: defaultLogPath(projectRoot, startedAt, conversation.id.slice(0, LOG_SUFFIX_LENGTH)),
      print: (line) => { if (isCurrent() && workspace?.current.bus === bus) printTerminal(line); },
      mode: displayMode,
    });
    const created = coordinator;
    return { conversationId: conversation.id, workDir, bus, coordinator: created,
      close: async () => { registered.get(created)?.(); registered.delete(created); await created.stop(); await mcp.close(); } };
  };
  workspace = new Workspace({ notify, history, projectRoot, createRuntime, createWorktree });
  await workspace.init();
  const activeWorkspace = workspace;
  const working = (id: string): ReadonlySet<AgentId> => new Set(
    activeWorkspace.allRuntimes().find((runtime) => runtime.conversationId === id)?.coordinator.status()
      .filter((agent) => agent.status === "busy" || agent.status === "starting").map((agent) => agent.id) ?? [],
  );
  const save = () => saveRecovery(homeDir, projectRoot, { current: history.currentId, conversations: activeWorkspace.recoveryConversations() });
  activeWorkspace.onRecoveryChange(save);
  history.onSwitch(save);
  history.onRemove(save);
  let restored = false;
  const registerRuntime = (runtime: ConversationRuntime) => {
    if (!registered.has(runtime.coordinator)) registered.set(runtime.coordinator, registerCoordinator(runtime.coordinator));
  };
  const feedStore = new FeedStore(feedDirPath(statePath));
  let feedSaveFailed = false;
  const saveFeedItem = (conversationId: string, item: HistoryItem) => {
    try {
      feedStore.append(conversationId, item);
    } catch (error) {
      if (!feedSaveFailed) process.stderr.write(`feed save failed: ${errorMessage(error)}\n`);
      feedSaveFailed = true;
    }
  };
  const applyLimits = (next: Partial<BudgetLimits>) => {
    settingsStore.setLimits(next);
    overrides = next;
    limits = { ...baseLimits, ...overrides };
    for (const runtime of activeWorkspace.allRuntimes()) runtime.coordinator.setLimits(limits);
  };
  return {
    sandbox, probe,
    get limits() { return { ...limits }; },
    setLimit: (name, value) => applyLimits({ ...overrides, [LIMIT_KEYS[name]]: value }),
    resetLimits: () => applyLimits({}),
    projectRoot, config, primary, history, workspace: activeWorkspace, settingsStore, feedStore,
    artifactsDir, uploadsDir, resumedSessions, savedSettings, startedAt,
    currentPreview: () => createFilePreview({ projectRoot: activeWorkspace.current.workDir, allowedDirs: [artifactsDir, uploadsDir] }),
    saveFeedItem,
    restore: async () => {
      if (restored) return;
      restored = true;
      if (recovery) await activeWorkspace.restore(recovery);
      save();
    },
    bindFeed: (feed, current) => {
      connectConversationFeed(history, feedStore, { replace: (items) => { if (current()) feed.replace(items); } }, working);
      activeWorkspace.onRuntime(registerRuntime);
      for (const runtime of activeWorkspace.allRuntimes()) registerRuntime(runtime);
    },
    showFeed: (feed) => feed.replace(feedStore.load(history.currentId, working(history.currentId))),
    close: async () => { generation++; await activeWorkspace.closeAll(); await sandbox.platform.close(); },
  };
};
