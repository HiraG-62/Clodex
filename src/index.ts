#!/usr/bin/env node
// clodex コマンドの入口。部品の組み立てと terminal I/O だけを行う
import { homedir } from "node:os";
import { clearLine, createInterface, cursorTo } from "node:readline";
import { AGENT_IDS, type AgentId } from "./agents/agent-adapter.js";
import { ClaudeAdapter } from "./agents/claude-adapter.js";
import { CodexAdapter } from "./agents/codex-adapter.js";
import { parseCliArgs } from "./cli/args.js";
import { createCommandRunner } from "./cli/command-runner.js";
import { createShell } from "./cli/shell.js";
import { loadConfig } from "./config/config.js";
import { buildRoleInstructions } from "./context/role-instructions.js";
import { DEFAULT_LIMITS } from "./coordinator/budget-manager.js";
import { Coordinator } from "./coordinator/coordinator.js";
import { EventBus } from "./coordinator/event-bus.js";
import { attachEventLog, defaultLogPath, type DisplayMode } from "./logging/event-log.js";
import { startMcpServer } from "./mcp/server.js";
import { resolveProjectRoot } from "./project/project-root.js";
import { FeedStore, feedDirPath } from "./web/feed-store.js";
import { connectConversationFeed } from "./web/conversation-feed.js";
import { DEFAULT_RECENT_ITEMS, WebFeed } from "./web/web-feed.js";
import { startWebServer } from "./web/web-server.js";
import { connectWebFeed } from "./web/web-ui.js";
import { loadOrCreateWebToken } from "./web/web-token.js";
import { ConversationHistory, conversationStatePath } from "./project/conversation-history.js";
import { AgentSettingsStore, agentSettingsPath, resolveStartSettings, type SavedAgentSettings } from "./project/agent-settings.js";

const PROMPT = "clodex> ";
const DEFAULT_WEB_PORT = 4319;
const DEFAULT_PRIMARY: AgentId = "claude";
const EXIT_FAILURE = 1;
// cleanup 後に何かが残って終わらない場合の保険
const FORCE_EXIT_DELAY_MS = 3_000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// 保存した設定で起動したことを案内する（full が黙って引き継がれないように）
const describeSavedSettings = (saved: SavedAgentSettings): string | undefined => {
  const parts = AGENT_IDS.flatMap((id) => Object.entries(saved[id] ?? {}).map(([key, value]) => `${id} ${key} ${value}`));
  return parts.length ? `saved settings: ${parts.join(", ")}` : undefined;
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  const projectRoot = resolveProjectRoot({ ...(args.project ? { explicitProject: args.project } : {}), cwd: process.cwd() });
  const config = loadConfig({ homeDir: homedir(), projectRoot });
  // 優先順位: 起動オプション > 設定ファイル > 既定値（DESIGN.md §13 Roles）
  const primary = args.primary ?? config.primary ?? DEFAULT_PRIMARY;

  const bus = new EventBus();
  const statePath = conversationStatePath(homedir(), projectRoot);
  const history = new ConversationHistory(statePath, { resumeLatest: args.resume });
  const resumeSessionIds = history.currentSessions;
  history.attach(bus);
  const settingsStore = new AgentSettingsStore(agentSettingsPath(statePath));
  const savedSettings = settingsStore.load();
  let coordinator: Coordinator | undefined;
  const mcp = await startMcpServer((from, input) => coordinator!.receiveMessage(from, input));
  coordinator = new Coordinator({
    projectRoot,
    agents: { claude: new ClaudeAdapter(), codex: new CodexAdapter() },
    bus,
    mcpUrlFor: (agent) => mcp.urlFor(agent),
    // 優先順位: 起動オプション > 保存した値 > 設定ファイル（DESIGN.md §9 Agent の設定の保存）
    settings: resolveStartSettings({ saved: savedSettings, models: args.models, ...(config.permission ? { configPermission: config.permission } : {}) }),
    instructions: Object.fromEntries(AGENT_IDS.map((id) => [id, buildRoleInstructions(id, config.roles)])),
    limits: { ...DEFAULT_LIMITS, ...config.limits },
    ...(config.usageAlert ? { usageAlert: config.usageAlert } : {}),
    resumeSessionIds,
  });

  const interactive = Boolean(process.stdin.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT, terminal: interactive });
  // Web UI の feed は会話ごとに保存し、起動時と会話の切り替え時に読み込む（DESIGN.md §18）
  const feedStore = new FeedStore(feedDirPath(statePath));
  let feedSaveFailed = false;
  const feed = new WebFeed(DEFAULT_RECENT_ITEMS, (item) => {
    try {
      feedStore.append(history.currentId, item);
    } catch (error) {
      // 保存できなくても作業は続ける。警告は 1 回だけ
      if (!feedSaveFailed) process.stderr.write(`feed save failed: ${errorMessage(error)}
`);
      feedSaveFailed = true;
    }
  });
  connectConversationFeed(history, feedStore, feed);
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

  // コマンドの出力は terminal と Web UI の両方に出す（event は Web UI へ構造化して別に送る）
  const print = (line: string) => {
    feed.publishOutput(line);
    printTerminal(line);
  };

  const logPath = defaultLogPath(projectRoot, new Date());
  let displayMode: DisplayMode = "normal";
  attachEventLog(bus, { path: logPath, print: printTerminal, mode: () => displayMode });
  // 起動時の案内は terminal 向けなので Web UI には出さない
  printTerminal(`Clodex v0.1  project: ${projectRoot}  primary: ${primary}`);
  printTerminal(`log: ${logPath}`);
  const savedNotice = describeSavedSettings(savedSettings);
  if (savedNotice) printTerminal(savedNotice);
  if (args.resume) {
    const resumed = AGENT_IDS.filter((id) => resumeSessionIds[id]);
    printTerminal(`resume: ${resumed.length ? resumed.join(", ") : "no saved conversation (starting a new one)"}`);
  }
  printTerminal("Type /help for usage.");

  const toggleVerbose = () => {
    displayMode = displayMode === "verbose" ? "normal" : "verbose";
    return displayMode === "verbose";
  };
  const runner = createCommandRunner({ cwd: projectRoot, print });
  const shell = createShell({
    coordinator, primary, print, toggleVerbose, history, runner,
    saveSettings: (agents, change) => {
      try {
        settingsStore.update(agents, change);
      } catch (error) {
        print(`settings save failed: ${errorMessage(error)}`);
      }
    },
  });
  const { refreshState } = connectWebFeed(bus, feed, () => ({
    project: projectRoot,
    primary: shell.getPrimary(),
    roles: config.roles ?? {},
    agents: coordinator.status(),
    conversations: history.list().map((c) => ({ ...c, current: c.id === history.currentId })),
  }));
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
      // terminal と同じ解釈を通す。/exit も受け付ける
      onInput: async (line) => {
        if ((await handleLine(line)) === "exit") void shutdown();
      },
      onError: (error) => print(`error: ${errorMessage(error)}`),
    })
    : undefined;
  if (web) printTerminal(`web: ${web.url}/?token=<~/.clodex/web-token>  (remote: tailscale serve)`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    runner.stopAll();
    await coordinator.stop();
    await mcp.close();
    await web?.close();
    // process.exit は出力のフラッシュ前に終了しうるので、自然終了させる
    setTimeout(() => process.exit(0), FORCE_EXIT_DELAY_MS).unref();
  };

  // コマンドの失敗（interrupt の RPC エラー等）でシェルを落とさない
  const report = (error: unknown) => print(`error: ${errorMessage(error)}`);

  rl.on("SIGINT", () => void shell.handleSigint().catch(report));
  rl.on("line", (line) => {
    void handleLine(line)
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
    void coordinator.whenIdle().then(shutdown);
  });
  if (interactive) rl.prompt();
};

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(EXIT_FAILURE);
});
