#!/usr/bin/env node
// clodex コマンドの入口。部品の組み立てと terminal I/O だけを行う
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { clearLine, createInterface, cursorTo } from "node:readline";
import { AGENT_IDS, type AgentId } from "./agents/agent-adapter.js";
import { ClaudeAdapter } from "./agents/claude-adapter.js";
import { CodexAdapter } from "./agents/codex-adapter.js";
import { parseCliArgs } from "./cli/args.js";
import { createCommandRunner } from "./cli/command-runner.js";
import { completeCommand } from "./cli/commands.js";
import { createShell, type ConversationList } from "./cli/shell.js";
import { loadConfig } from "./config/config.js";
import { detectLanguage } from "./context/language.js";
import { buildRoleInstructions } from "./context/role-instructions.js";
import { DEFAULT_LIMITS } from "./coordinator/budget-manager.js";
import { Coordinator } from "./coordinator/coordinator.js";
import { EventBus } from "./coordinator/event-bus.js";
import { Workspace, type ConversationRuntime } from "./hub/workspace.js";
import { setLanguage, t } from "./i18n/i18n.js";
import { attachEventLog, defaultLogPath, type DisplayMode } from "./logging/event-log.js";
import { startMcpServer } from "./mcp/server.js";
import { AgentSettingsStore, agentSettingsPath, resolveStartSettings, type SavedAgentSettings } from "./project/agent-settings.js";
import { ConversationHistory, conversationStatePath, type Conversation } from "./project/conversation-history.js";
import { artifactsDirPath, createFilePreview, uploadsDirPath } from "./project/file-preview.js";
import { listProjectFiles } from "./project/project-files.js";
import { resolveProjectRoot } from "./project/project-root.js";
import { MAX_UPLOAD_BYTES, isUploadType, saveUpload } from "./project/uploads.js";
import { createWorktree } from "./project/worktree.js";
import { connectConversationFeed } from "./web/conversation-feed.js";
import { FeedStore, feedDirPath } from "./web/feed-store.js";
import { DEFAULT_RECENT_ITEMS, WebFeed } from "./web/web-feed.js";
import { buildWebPage } from "./web/web-page.js";
import { startWebServer } from "./web/web-server.js";
import { loadOrCreateWebToken } from "./web/web-token.js";
import { connectWebFeed, historyItemOf } from "./web/web-ui.js";

const PROMPT = "clodex> ";
const DEFAULT_WEB_PORT = 4319;
const DEFAULT_PRIMARY: AgentId = "claude";
const EXIT_FAILURE = 1;
// cleanup 後に何かが残って終わらない場合の保険
const FORCE_EXIT_DELAY_MS = 3_000;
// 会話ごとの Event Log のファイル名に付ける会話 ID の長さ
const LOG_SUFFIX_LENGTH = 8;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// 保存した設定で起動したことを案内する（full が黙って引き継がれないように）
const describeSavedSettings = (saved: SavedAgentSettings): string | undefined => {
  const parts = AGENT_IDS.flatMap((id) => Object.entries(saved[id] ?? {}).map(([key, value]) => `${id} ${key} ${value}`));
  return parts.length ? t("start.saved", { settings: parts.join(", ") }) : undefined;
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  const projectRoot = resolveProjectRoot({ ...(args.project ? { explicitProject: args.project } : {}), cwd: process.cwd() });
  const config = loadConfig({ homeDir: homedir(), projectRoot });
  // 優先順位: 起動オプション > 設定ファイル > 既定値（DESIGN.md §13 Roles）
  const primary = args.primary ?? config.primary ?? DEFAULT_PRIMARY;
  const language = config.language ?? detectLanguage();
  setLanguage(language);

  const statePath = conversationStatePath(homedir(), projectRoot);
  // Agent が証跡の画像を置く場所と、貼り付けた画像の保存先（DESIGN.md §28 v0.3 B・C）
  const artifactsDir = artifactsDirPath(homedir(), statePath);
  mkdirSync(artifactsDir, { recursive: true });
  const uploadsDir = uploadsDirPath(homedir(), statePath);
  const history = new ConversationHistory(statePath, { resumeLatest: args.resume });
  const resumedSessions = history.currentSessions;
  const settingsStore = new AgentSettingsStore(agentSettingsPath(statePath));
  const savedSettings = settingsStore.load();
  const startedAt = new Date();

  const interactive = Boolean(process.stdin.isTTY);
  const rl = createInterface({
    input: process.stdin, output: process.stdout, prompt: PROMPT, terminal: interactive, completer: completeCommand,
  });
  // 入力途中の行を壊さないよう、プロンプトの上に出力してから入力行を描き直す
  const printTerminal = (line: string) => {
    if (!interactive) {
      process.stdout.write(`${line}\n`);
      return;
    }
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(`${line}\n`);
    rl.prompt(true);
  };
  let displayMode: DisplayMode = "normal";

  // 会話ごとに Coordinator・Agent・MCP server・Event Log を持つ（DESIGN.md §28 D1）
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
      // 優先順位: 起動オプション > 保存した値 > 設定ファイル（DESIGN.md §9 Agent の設定の保存）
      settings: resolveStartSettings({
        saved: settingsStore.load(), models: args.models, ...(config.permission ? { configPermission: config.permission } : {}),
      }),
      instructions: Object.fromEntries(AGENT_IDS.map((id) => [id, buildRoleInstructions(id, config.roles, { language, artifactsDir })])),
      limits: { ...DEFAULT_LIMITS, ...config.limits },
      ...(config.usageAlert ? { usageAlert: config.usageAlert } : {}),
      resumeSessionIds: conversation.sessions,
      language,
    });
    // terminal には今の会話の event だけを出す。file には会話ごとに全 event を残す
    attachEventLog(bus, {
      path: defaultLogPath(projectRoot, startedAt, conversation.id.slice(0, LOG_SUFFIX_LENGTH)),
      print: (line) => { if (workspace?.current.bus === bus) printTerminal(line); },
      mode: () => displayMode,
    });
    const created = coordinator;
    return {
      conversationId: conversation.id, workDir, bus, coordinator: created,
      close: async () => {
        await created.stop();
        await mcp.close();
      },
    };
  };
  workspace = new Workspace({ history, projectRoot, createRuntime, createWorktree });
  await workspace.init();
  const ws = workspace;

  // 今の会話の作業場所で、成果物のプレビューと @path の参照を扱う（DESIGN.md §28 v0.3 B・C）
  const currentPreview = () => createFilePreview({ projectRoot: ws.current.workDir, allowedDirs: [artifactsDir, uploadsDir] });

  // Web UI の feed は会話ごとに保存し、起動時と会話の切り替え時に読み込む（DESIGN.md §18）
  const feedStore = new FeedStore(feedDirPath(statePath));
  let feedSaveFailed = false;
  const saveFeedItem = (conversationId: string, item: Parameters<FeedStore["append"]>[1]) => {
    try {
      feedStore.append(conversationId, item);
    } catch (error) {
      // 保存できなくても作業は続ける。警告は 1 回だけ
      if (!feedSaveFailed) process.stderr.write(`feed save failed: ${errorMessage(error)}\n`);
      feedSaveFailed = true;
    }
  };
  const feed = new WebFeed(DEFAULT_RECENT_ITEMS, (item) => saveFeedItem(history.currentId, item));
  connectConversationFeed(history, feedStore, feed);

  // コマンドの出力は terminal と Web UI の両方に出す（event は Web UI へ構造化して別に送る）
  const print = (line: string) => {
    feed.publishOutput(line);
    printTerminal(line);
  };

  // 起動時の案内は terminal 向けなので Web UI には出さない
  printTerminal(t("start.banner", { project: projectRoot, primary }));
  printTerminal(t("start.log", { path: defaultLogPath(projectRoot, startedAt, history.currentId.slice(0, LOG_SUFFIX_LENGTH)) }));
  const savedNotice = describeSavedSettings(savedSettings);
  if (savedNotice) printTerminal(savedNotice);
  if (args.resume) {
    const resumed = AGENT_IDS.filter((id) => resumedSessions[id]);
    printTerminal(t("start.resume", { agents: resumed.length ? resumed.join(", ") : t("start.noSaved") }));
  }
  printTerminal(t("start.help"));

  const toggleVerbose = () => {
    displayMode = displayMode === "verbose" ? "normal" : "verbose";
    return displayMode === "verbose";
  };
  const runner = createCommandRunner({ cwd: () => ws.current.workDir, print });
  // 会話の一覧は履歴、切り替えと新しい会話は Workspace（前の会話の Agent を止めない）
  const conversations: ConversationList = {
    get currentId() { return history.currentId; },
    list: () => history.list(),
    switchTo: (id) => ws.switchTo(id),
    startNew: (options) => ws.startNew(options),
    clearSession: (agent) => history.clearSession(agent),
    rename: (title) => history.rename(title),
    remove: (id) => history.remove(id),
    togglePin: (id) => history.togglePin(id),
  };
  const shell = createShell({
    coordinator: () => ws.current.coordinator, primary, print, toggleVerbose, history: conversations, runner,
    busyElsewhere: () => ws.busyElsewhereInSameDir(),
    resolveReference: (path) => currentPreview().locate(path),
    saveSettings: (agents, change) => {
      try {
        settingsStore.update(agents, change);
      } catch (error) {
        print(t("error.settingsSave", { message: errorMessage(error) }));
      }
    },
  });
  const currentEvents = { subscribe: (listener: Parameters<EventBus["subscribe"]>[0]) =>
    ws.onEvent((_runtime, event, current) => { if (current) listener(event); }) };
  const { refreshState } = connectWebFeed(currentEvents, feed, () => ({
    project: ws.current.workDir,
    primary: shell.getPrimary(),
    roles: config.roles ?? {},
    agents: ws.current.coordinator.status(),
    pendingInputs: ws.current.coordinator.pendingInputs(),
    conversations: history.list().map((c) => {
      const activity = ws.activity(c.id);
      return { ...c, current: c.id === history.currentId, ...(activity ? { activity } : {}) };
    }),
  }), language);
  // 今の会話でない会話の event は、その会話の feed に保存する（戻ったときに流れを表示できる）
  ws.onEvent((runtime, event, current) => {
    if (current) return;
    const item = historyItemOf(event, language);
    if (item) saveFeedItem(runtime.conversationId, item);
    refreshState();
  });
  const handleLine = async (line: string) => {
    const outcome = await shell.handleLine(line);
    refreshState();
    return outcome;
  };

  const webEnabled = args.web || config.web !== undefined;
  const web = webEnabled
    ? await startWebServer({
      port: config.web?.port ?? DEFAULT_WEB_PORT,
      token: loadOrCreateWebToken(homedir()),
      feed,
      page: buildWebPage(language),
      // terminal と同じ解釈を通す。/exit も受け付ける
      onInput: async (line) => {
        if ((await handleLine(line)) === "exit") void shutdown();
      },
      listFiles: () => listProjectFiles(ws.current.workDir),
      preview: {
        file: (path) => currentPreview().file(path),
        diff: (path) => currentPreview().diff(path),
      },
      upload: {
        maxBytes: MAX_UPLOAD_BYTES, accepts: isUploadType,
        save: (contentType, body) => saveUpload(uploadsDir, contentType, body),
      },
      onError: (error) => print(t("error.generic", { message: errorMessage(error) })),
    })
    : undefined;
  if (web) printTerminal(t("start.web", { url: web.url }));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    runner.stopAll();
    await ws.closeAll();
    await web?.close();
    // process.exit は出力のフラッシュ前に終了しうるので、自然終了させる
    setTimeout(() => process.exit(0), FORCE_EXIT_DELAY_MS).unref();
  };

  // コマンドの失敗（interrupt の RPC エラー等）でシェルを落とさない
  const report = (error: unknown) => print(t("error.generic", { message: errorMessage(error) }));

  rl.on("SIGINT", () => void shell.handleSigint().catch(report));
  // 入力行は届いた順に処理する（会話の切り替えや worktree の作成を待ってから次の行へ。送信自体はキューに積むだけ）
  let lines = Promise.resolve();
  rl.on("line", (line) => {
    lines = lines
      .then(() => handleLine(line))
      .then((outcome) => {
        if (outcome === "exit") return shutdown();
        if (interactive) rl.prompt();
        return undefined;
      })
      .catch(report);
  });
  // 入力の終端（パイプ入力の最後・Ctrl+D）では、受け付けた配送が終わるのを待ってから終了する
  rl.on("close", () => {
    if (shuttingDown) return;
    void lines.then(() => ws.current.coordinator.whenIdle()).then(shutdown);
  });
  if (interactive) rl.prompt();
};

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(EXIT_FAILURE);
});
