// project ごとの設定・会話・Agent・保存をまとめる（DESIGN.md §28 D2a）
import { mkdirSync } from "node:fs";
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import { ClaudeAdapter } from "../agents/claude-adapter.js";
import { CodexAdapter } from "../agents/codex-adapter.js";
import type { CliArgs } from "../cli/args.js";
import { loadConfig, type ClodexConfig } from "../config/config.js";
import type { Language } from "../context/language.js";
import { buildRoleInstructions } from "../context/role-instructions.js";
import { DEFAULT_LIMITS } from "../coordinator/budget-manager.js";
import { Coordinator } from "../coordinator/coordinator.js";
import { EventBus } from "../coordinator/event-bus.js";
import { Workspace, type ConversationRuntime } from "./workspace.js";
import { attachEventLog, defaultLogPath, type DisplayMode } from "../logging/event-log.js";
import { startMcpServer } from "../mcp/server.js";
import { AgentSettingsStore, agentSettingsPath, resolveStartSettings, type SavedAgentSettings } from "../project/agent-settings.js";
import { ConversationHistory, conversationStatePath, type Conversation, type SavedSessions } from "../project/conversation-history.js";
import { artifactsDirPath, createFilePreview, uploadsDirPath } from "../project/file-preview.js";
import { createWorktree } from "../project/worktree.js";
import { connectConversationFeed } from "../web/conversation-feed.js";
import { FeedStore, feedDirPath } from "../web/feed-store.js";
import type { HistoryItem, WebFeed } from "../web/web-feed.js";

const LOG_SUFFIX_LENGTH = 8;
const DEFAULT_PRIMARY: AgentId = "claude";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface ProjectContext {
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
  currentPreview(): ReturnType<typeof createFilePreview>;
  saveFeedItem(conversationId: string, item: HistoryItem): void;
  bindFeed(feed: WebFeed, isCurrent: () => boolean): void;
  showFeed(feed: WebFeed): void;
  close(): Promise<void>;
}

export interface OpenProjectOptions {
  projectRoot: string;
  homeDir: string;
  args: CliArgs;
  language: Language;
  printTerminal(line: string): void;
  displayMode(): DisplayMode;
  isCurrent(): boolean;
}

export const openProject = async ({
  projectRoot, homeDir, args, language, printTerminal, displayMode, isCurrent,
}: OpenProjectOptions): Promise<ProjectContext> => {
  const config = loadConfig({ homeDir, projectRoot });
  const primary = args.primary ?? config.primary ?? DEFAULT_PRIMARY;
  const statePath = conversationStatePath(homeDir, projectRoot);
  const artifactsDir = artifactsDirPath(homeDir, statePath);
  mkdirSync(artifactsDir, { recursive: true });
  const uploadsDir = uploadsDirPath(homeDir, statePath);
  const history = new ConversationHistory(statePath, { resumeLatest: args.resume });
  const resumedSessions = history.currentSessions;
  const settingsStore = new AgentSettingsStore(agentSettingsPath(statePath));
  const savedSettings = settingsStore.load();
  const startedAt = new Date();
  let workspace: Workspace | undefined;

  const createRuntime = async (conversation: Conversation): Promise<ConversationRuntime> => {
    const bus = new EventBus();
    const workDir = conversation.workDir ?? projectRoot;
    let coordinator: Coordinator | undefined;
    const mcp = await startMcpServer((from, input) => coordinator!.receiveMessage(from, input));
    coordinator = new Coordinator({
      projectRoot: workDir,
      agents: { claude: new ClaudeAdapter(), codex: new CodexAdapter() },
      bus,
      mcpUrlFor: (agent) => mcp.urlFor(agent),
      settings: resolveStartSettings({
        saved: settingsStore.load(), models: args.models, ...(config.permission ? { configPermission: config.permission } : {}),
      }),
      instructions: (id) => buildRoleInstructions(id, config.roles, { language, artifactsDir }),
      limits: { ...DEFAULT_LIMITS, ...config.limits },
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
      close: async () => { await created.stop(); await mcp.close(); } };
  };
  workspace = new Workspace({ history, projectRoot, createRuntime, createWorktree });
  await workspace.init();
  const activeWorkspace = workspace;
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
  return {
    projectRoot, config, primary, history, workspace: activeWorkspace, settingsStore, feedStore,
    artifactsDir, uploadsDir, resumedSessions, savedSettings, startedAt,
    currentPreview: () => createFilePreview({ projectRoot: activeWorkspace.current.workDir, allowedDirs: [artifactsDir, uploadsDir] }),
    saveFeedItem,
    bindFeed: (feed, current) => connectConversationFeed(history, feedStore, { replace: (items) => { if (current()) feed.replace(items); } }),
    showFeed: (feed) => feed.replace(feedStore.load(history.currentId)),
    close: () => activeWorkspace.closeAll(),
  };
};
