#!/usr/bin/env node
// Hub の入口。project ごとの初期化は ProjectContext に任せる（DESIGN.md §28 D2a）
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { AGENT_IDS, type AgentId } from "./agents/agent-adapter.js";
import { EMPTY_MODEL_CATALOG, fetchStartupProbe, type StartupProbe } from "./agents/startup-probe.js";
import type { Coordinator } from "./coordinator/coordinator.js";
import { parseCliArgs } from "./cli/args.js";
import { createCommandRunner } from "./cli/command-runner.js";
import { createProcessManager } from "./process/process-manager.js";
import { completeCommand } from "./cli/commands.js";
import { createShell, type ConversationList } from "./cli/shell.js";
import { ensureUserConfigTemplate, loadConfig } from "./config/config.js";
import { detectLanguage } from "./context/language.js";
import type { CoordinatorEvent } from "./coordinator/event-bus.js";
import { Hub } from "./hub/hub.js";
import { clearHubLock, isHubAlive, readHubLock, writeHubLock } from "./hub/hub-lock.js";
import { openProject, type ProjectContext } from "./hub/project-context.js";
import { selectProject } from "./hub/project-selection.js";
import { setLanguage, t } from "./i18n/i18n.js";
import { defaultLogPath, type DisplayMode } from "./logging/event-log.js";
import { listProjectFiles } from "./project/project-files.js";
import { resolveProjectRoot } from "./project/project-root.js";
import { saveProjectRole } from "./project/role-settings.js";
import { createLocalFeedClient, createRemoteFeedClient } from "./tui/feed-client.js";
import { startTui } from "./tui/tui.js";
import { MAX_UPLOAD_BYTES, isUploadType, saveUpload } from "./project/uploads.js";
import { DEFAULT_RECENT_ITEMS, WebFeed } from "./web/web-feed.js";
import { buildWebPage } from "./web/web-page.js";
import { startWebServer } from "./web/web-server.js";
import { loadOrCreateWebToken, webTokenPath } from "./web/web-token.js";
import { connectWebFeed, historyItemOf } from "./web/web-ui.js";

const PROMPT = "clodex> ";
const DEFAULT_WEB_PORT = 4319;
const DEFAULT_PRIMARY: AgentId = "claude";
const EXIT_FAILURE = 1;
const FORCE_EXIT_DELAY_MS = 3_000;
const LOG_SUFFIX_LENGTH = 8;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const conversationsOf = (context: ProjectContext): ConversationList => ({
  get currentId() { return context.history.currentId; },
  list: () => context.history.list(),
  switchTo: (id) => context.workspace.switchTo(id),
  startNew: (options) => context.workspace.startNew(options),
  clearSession: (agent) => context.history.clearSession(agent),
  rename: (title) => context.history.rename(title),
  remove: (id) => context.history.remove(id),
  togglePin: (id) => context.history.togglePin(id),
});

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  const homeDir = homedir();
  const cwd = process.cwd();
  ensureUserConfigTemplate(homeDir);
  // 言語と Web のポートは Hub 全体で 1 つ。project の設定は ProjectContext が読む。
  const hubConfig = loadConfig({ homeDir, projectRoot: homeDir });
  const language = hubConfig.language ?? detectLanguage();
  setLanguage(language);
  const interactive = !args.serve && Boolean(process.stdin.isTTY);
  const liveHub = interactive ? readHubLock(homeDir) : undefined;
  if (liveHub && isHubAlive(liveHub)) {
    const token = readFileSync(webTokenPath(homeDir), "utf8").trim();
    const client = createRemoteFeedClient(liveHub, token);
    await client.send(`/project ${cwd}`);
    await startTui(client);
    return;
  }
  const rl = args.serve || interactive ? undefined : createInterface({
    input: process.stdin, output: process.stdout, prompt: PROMPT, terminal: false, completer: completeCommand,
  });
  const printTerminal = (line: string) => {
    if (interactive) return;
    process.stdout.write(`${line}\n`);
  };
  let displayMode: DisplayMode = "normal";
  let refreshState = () => {};
  let modelCatalog = EMPTY_MODEL_CATALOG();
  let startupUsage: StartupProbe["usage"] | undefined;
  const coordinators = new Set<Coordinator>();
  const registerCoordinator = (coordinator: Coordinator) => {
    coordinators.add(coordinator);
    if (startupUsage) coordinator.applyStartupUsage(startupUsage);
    return () => { coordinators.delete(coordinator); };
  };
  const currentListeners = new Set<(event: CoordinatorEvent) => void>();
  let hub: Hub<ProjectContext>;
  const feed = new WebFeed(DEFAULT_RECENT_ITEMS, (item) => {
    const context = hub.current;
    if (context) context.saveFeedItem(context.history.currentId, item);
  });
  hub = new Hub({ homeDir, cwd, openProject: async (projectRoot) => {
    let context: ProjectContext;
    context = await openProject({
      projectRoot, homeDir, args, language, printTerminal, displayMode: () => displayMode,
      isCurrent: () => hub.current === context, modelCatalog: () => modelCatalog, registerCoordinator,
    });
    context.workspace.onEvent((runtime, event, current) => {
      if (hub.current === context && current) {
        for (const listener of currentListeners) listener(event);
      } else {
        const item = historyItemOf(event, language);
        if (item) context.saveFeedItem(runtime.conversationId, item);
      }
      refreshState();
    });
    context.bindFeed(feed, () => hub.current === context);
    await context.restore();
    return context;
  } });
  void fetchStartupProbe(cwd).then((probe) => {
    modelCatalog = probe.models;
    startupUsage = probe.usage;
    for (const coordinator of coordinators) coordinator.applyStartupUsage(probe.usage);
    refreshState();
  });

  const openInHub = async (path: string): Promise<ProjectContext> => {
    const context = await selectProject(hub, feed, path);
    refreshState();
    return context;
  };
  const initial = args.project
    ? resolveProjectRoot({ explicitProject: args.project, cwd })
    : args.serve ? hub.lastProject : resolveProjectRoot({ cwd });
  for (const project of hub.recoveryProjects().filter((project) => project !== initial)) await openInHub(project);
  if (initial) await openInHub(initial);

  const print = (line: string) => { feed.publishOutput(line); printTerminal(line); };
  const toggleVerbose = () => { displayMode = displayMode === "verbose" ? "normal" : "verbose"; return displayMode === "verbose"; };
  const current = () => {
    const context = hub.current;
    if (!context) throw new Error(t("shell.noProjectSelected"));
    return context;
  };
  const runner = createCommandRunner({ cwd: () => hub.current?.workspace.current.workDir ?? cwd, print });
  const processes = createProcessManager({ cwd: () => hub.current?.workspace.current.workDir ?? cwd, print, onChange: () => refreshState() });
  const shell = createShell({
    coordinator: () => current().workspace.current.coordinator,
    history: () => conversationsOf(current()),
    primary: hub.current?.primary ?? DEFAULT_PRIMARY,
    print, toggleVerbose, runner, processes,
    projects: { list: () => hub.list(), open: openInHub, hasCurrent: () => hub.current !== undefined },
    roles: () => current().config.roles ?? {},
    saveRole: (agent, text) => {
      const context = current();
      const saved = saveProjectRole(context.projectRoot, agent, text);
      context.config.roles = { ...context.config.roles, [agent]: saved };
      return saved;
    },
    busyElsewhere: () => current().workspace.busyElsewhereInSameDir(),
    resolveReference: (path) => current().currentPreview().locate(path),
    saveSettings: (agents, change) => {
      try { current().settingsStore.update(agents, change); }
      catch (error) { print(t("error.settingsSave", { message: errorMessage(error) })); }
    },
  });
  const { refreshState: requestState } = connectWebFeed({
    subscribe: (listener) => { currentListeners.add(listener); return () => currentListeners.delete(listener); },
  }, feed, () => {
    const context = hub.current;
    return {
      project: context?.workspace.current.workDir ?? "",
      projects: hub.list(),
      primary: shell.getPrimary(),
      roles: context?.config.roles ?? {},
      agents: context?.workspace.current.coordinator.status() ?? [],
      pendingInputs: context?.workspace.current.coordinator.pendingInputs() ?? [],
      processes: processes.list().map(({ id, command, status }) => ({ id, command, status })),
      conversations: context?.history.list().map((conversation) => {
        const activity = context.workspace.activity(conversation.id);
        return { ...conversation, current: conversation.id === context.history.currentId, ...(activity ? { activity } : {}) };
      }) ?? [],
    };
  }, language);
  refreshState = requestState;
  refreshState();

  const handleLine = async (line: string) => {
    const outcome = await shell.handleLine(line);
    refreshState();
    return outcome;
  };
  const web = args.web || hubConfig.web !== undefined ? await startWebServer({
    port: hubConfig.web?.port ?? DEFAULT_WEB_PORT,
    token: loadOrCreateWebToken(homeDir), feed, page: buildWebPage(language),
    onInput: async (line) => { if ((await handleLine(line)) === "exit") void shutdown(); },
    listFiles: () => hub.current ? listProjectFiles(hub.current.workspace.current.workDir) : Promise.resolve([]),
    preview: {
      file: (path) => hub.current ? hub.current.currentPreview().file(path) : Promise.resolve({ ok: false, status: 404, message: "no project" }),
      diff: (path) => hub.current ? hub.current.currentPreview().diff(path) : Promise.resolve({ ok: false, status: 404, message: "no project" }),
    },
    upload: { maxBytes: MAX_UPLOAD_BYTES, accepts: isUploadType,
      save: (contentType, body) => saveUpload(current().uploadsDir, contentType, body) },
    onError: (error) => print(t("error.generic", { message: errorMessage(error) })),
  }) : undefined;
  if (args.serve && web) {
    const port = Number(new URL(web.url).port);
    writeHubLock(homeDir, { pid: process.pid, port, url: web.url });
  }

  if (!args.serve) {
    const context = hub.current;
    if (context) {
      printTerminal(t("start.banner", { project: context.projectRoot, primary: context.primary }));
      printTerminal(t("start.log", { path: defaultLogPath(context.projectRoot, context.startedAt, context.history.currentId.slice(0, LOG_SUFFIX_LENGTH)) }));
      const saved = AGENT_IDS.flatMap((id) => Object.entries(context.savedSettings[id] ?? {}).map(([key, value]) => `${id} ${key} ${value}`));
      if (saved.length) printTerminal(t("start.saved", { settings: saved.join(", ") }));
      if (args.resume) {
        const resumed = AGENT_IDS.filter((id) => context.resumedSessions[id]);
        printTerminal(t("start.resume", { agents: resumed.length ? resumed.join(", ") : t("start.noSaved") }));
      }
    }
    printTerminal(t("start.help"));
  }
  if (web) printTerminal(t("start.web", { url: web.url }));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl?.close();
    runner.stopAll();
    processes.stopAll();
    try {
      await hub.closeAll();
      await web?.close();
    } finally {
      if (args.serve) clearHubLock(homeDir, process.pid);
      setTimeout(() => process.exit(0), FORCE_EXIT_DELAY_MS).unref();
    }
  };
  const report = (error: unknown) => print(t("error.generic", { message: errorMessage(error) }));
  if (rl) {
    rl.on("SIGINT", () => void shell.handleSigint().catch(report));
    let lines = Promise.resolve();
    rl.on("line", (line) => {
      lines = lines.then(() => handleLine(line)).then((outcome) => {
        if (outcome === "exit") return shutdown();
        if (interactive) rl.prompt();
      }).catch(report);
    });
    rl.on("close", () => {
      if (shuttingDown) return;
      void lines.then(() => hub.current?.workspace.current.coordinator.whenIdle()).then(shutdown);
    });
  }
  if (interactive) {
    await startTui(createLocalFeedClient(feed, async (line) => { await handleLine(line); },
      () => hub.current ? listProjectFiles(hub.current.workspace.current.workDir) : Promise.resolve([])));
    await shutdown();
  }
  if (args.serve) {
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  }
};

main().catch((error: unknown) => { console.error(errorMessage(error)); process.exit(EXIT_FAILURE); });
