#!/usr/bin/env node
// Hub の入口。project ごとの初期化は ProjectContext に任せる（DESIGN.md §28 D2a）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { AGENT_IDS, type AgentId } from "./agents/agent-adapter.js";
import { EMPTY_MODEL_CATALOG } from "./agents/startup-probe.js";
import { type CliArgs, hubCommands, parseCliArgs } from "./cli/args.js";
import { type CommandLifecycle, createCommandRunner } from "./cli/command-runner.js";
import { completeCommand } from "./cli/commands.js";
import { type ConversationList, createShell, type ShellOutcome } from "./cli/shell.js";
import { clodexHomeDir, ensureUserConfigTemplate, loadConfig, saveUserLanguage } from "./config/config.js";
import { matchingRolePreset } from "./config/role-presets.js";
import { detectLanguage, type Language } from "./context/language.js";
import { LIMIT_KEYS, LIMIT_NAMES } from "./coordinator/budget-manager.js";
import type { Coordinator } from "./coordinator/coordinator.js";
import type { CoordinatorEvent } from "./coordinator/event-bus.js";
import { Hub } from "./hub/hub.js";
import { clearHubLock, isHubAlive, readHubLock, writeHubLock } from "./hub/hub-lock.js";
import { formatNotification, type NotificationInput, shouldPushNotification } from "./hub/notify-format.js";
import { openProject, type ProjectContext } from "./hub/project-context.js";
import { selectProject } from "./hub/project-selection.js";
import { installRuntimeErrors } from "./hub/runtime-errors.js";
import { MESSAGES, setLanguage, t } from "./i18n/i18n.js";
import { type DisplayMode, defaultLogPath } from "./logging/event-log.js";
import { pruneLogs } from "./logging/log-retention.js";
import { registerHubJob } from "./process/job-object.js";
import { createProcessManager } from "./process/process-manager.js";
import { listProjectFiles } from "./project/project-files.js";
import { saveProjectRole } from "./project/role-settings.js";
import { isUploadType, MAX_UPLOAD_BYTES, saveUpload } from "./project/uploads.js";
import { uninstallSandboxes } from "./sandbox/controller.js";
import { resetSandboxSettings } from "./sandbox/reset-settings.js";
import { initialProject, shouldStartWeb } from "./startup-options.js";
import { createLocalFeedClient, createRemoteFeedClient } from "./tui/feed-client.js";
import { startTui } from "./tui/tui.js";
import { type DesktopNotifyState, updateDesktopNotify } from "./web/client/desktop-notify.js";
import { PushService } from "./web/push.js";
import { buildLimitState, DEFAULT_RECENT_ITEMS, WebFeed } from "./web/web-feed.js";
import { buildWebPage } from "./web/web-page.js";
import { startWebServer, type WebServerHandle } from "./web/web-server.js";
import { loadOrCreateWebToken, webTokenPath } from "./web/web-token.js";
import { connectWebFeed, historyItemOf } from "./web/web-ui.js";

const PROMPT = "clodex> ";
const DEFAULT_WEB_PORT = 4319;
const DEFAULT_PRIMARY: AgentId = "claude";
const FORCE_EXIT_DELAY_MS = 3_000;
// GUI は Hub の終了をこれより長く待つ（gui/src-tauri/src/lib.rs の SHUTDOWN_TIMEOUT）
const STOP_TIMEOUT_MS = 10_000;
const LOG_SUFFIX_LENGTH = 8;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
let reportRuntimeError = (_message: string) => {};
const runtimeErrors = installRuntimeErrors({ home: clodexHomeDir(), report: message => reportRuntimeError(message) });

const conversationsOf = (context: ProjectContext): ConversationList => ({
  get currentId() {
    return context.history.currentId;
  },
  list: () => context.history.list(),
  switchTo: id => context.workspace.switchTo(id),
  startNew: options => context.workspace.startNew(options),
  clearSession: agent => context.history.clearSession(agent),
  rename: title => context.history.rename(title),
  renameConversation: (id, title) => context.history.renameConversation(id, title),
  setSolo: mode => context.history.setSolo(mode),
  remove: id => context.history.remove(id),
  togglePin: id => context.history.togglePin(id),
});

// src と dist のどちらから動かしても、1 つ上に package.json がある
const CLODEX_VERSION = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version;

const connectToHub = async (args: CliArgs, cwd: string, homeDir: string, interactive: boolean): Promise<boolean> => {
  const liveHub = interactive ? readHubLock(homeDir) : undefined;
  if (!liveHub || !(await isHubAlive(liveHub))) return false;
  let token: string;
  try {
    token = readFileSync(webTokenPath(homeDir), "utf8").trim();
  } catch (error) {
    process.stderr.write(`${t("error.webToken", { message: errorMessage(error) })}\n`);
    process.exitCode = 1;
    return true;
  }
  const client = createRemoteFeedClient(liveHub, token);
  const { commands, ignored } = hubCommands(args, cwd);
  for (const command of commands) await client.send(command);
  if (ignored.length) process.stderr.write(`${t("start.hubIgnored", { options: ignored.join(" ") })}\n`);
  await startTui(client);
  return true;
};

interface StartWebOptions {
  args: CliArgs;
  hasWebConfig: boolean;
  configuredPort?: number;
  homeDir: string;
  feed: WebFeed;
  hub: Hub<ProjectContext>;
  current: () => ProjectContext;
  language: () => Language;
  onInput: (line: string) => Promise<void>;
  onError: (error: unknown) => void;
  push: PushService;
}

const startWeb = async ({
  args,
  hasWebConfig,
  configuredPort,
  homeDir,
  feed,
  hub,
  current,
  language,
  onInput,
  onError,
  push,
}: StartWebOptions): Promise<WebServerHandle | undefined> => {
  if (!shouldStartWeb(args, hasWebConfig)) return undefined;
  const web = await startWebServer({
    port: configuredPort ?? DEFAULT_WEB_PORT,
    token: loadOrCreateWebToken(homeDir),
    feed,
    page: buildWebPage(language()),
    onInput,
    listFiles: () => (hub.current ? listProjectFiles(hub.current.workspace.current.workDir) : Promise.resolve([])),
    preview: {
      file: path => (hub.current ? hub.current.currentPreview().file(path) : Promise.resolve({ ok: false, status: 404, message: "no project" })),
      diff: path => (hub.current ? hub.current.currentPreview().diff(path) : Promise.resolve({ ok: false, status: 404, message: "no project" })),
    },
    upload: { maxBytes: MAX_UPLOAD_BYTES, accepts: isUploadType, save: (contentType, body) => saveUpload(current().uploadsDir, contentType, body) },
    onError,
    push,
  });
  if (args.serve) {
    const port = Number(new URL(web.url).port);
    writeHubLock(homeDir, { pid: process.pid, port, url: web.url });
  }
  return web;
};

const printStartup = (args: CliArgs, hub: Hub<ProjectContext>, homeDir: string, printTerminal: (line: string) => void): void => {
  if (!args.serve) {
    const context = hub.current;
    if (context) {
      printTerminal(t("start.banner", { version: CLODEX_VERSION, project: context.projectRoot, primary: context.primary }));
      printTerminal(
        t("start.log", { path: defaultLogPath(homeDir, context.projectRoot, context.startedAt, context.history.currentId.slice(0, LOG_SUFFIX_LENGTH)) }),
      );
      const saved = AGENT_IDS.flatMap(id => Object.entries(context.savedSettings[id] ?? {}).map(([key, value]) => `${id} ${key} ${value}`));
      for (const name of LIMIT_NAMES) {
        const value = context.savedSettings.limits?.[LIMIT_KEYS[name]];
        if (value !== undefined) saved.push(`limits ${name} ${value}`);
      }
      if (context.savedSettings.limitsUnlimited) saved.push("limits unlimited");
      if (saved.length) printTerminal(t("start.saved", { settings: saved.join(", ") }));
      if (args.resume) {
        const resumed = AGENT_IDS.filter(id => context.resumedSessions[id]);
        printTerminal(t("start.resume", { agents: resumed.length ? resumed.join(", ") : t("start.noSaved") }));
      }
    }
    printTerminal(t("start.help"));
  }
};

interface ShutdownOptions {
  args: CliArgs;
  homeDir: string;
  interactive: boolean;
  rl: ReturnType<typeof createInterface> | undefined;
  runner: ReturnType<typeof createCommandRunner>;
  processes: ReturnType<typeof createProcessManager>;
  hub: Hub<ProjectContext>;
  web: WebServerHandle | undefined;
  shell: ReturnType<typeof createShell>;
  handleLine: (line: string) => Promise<ShellOutcome>;
  print: (line: string) => void;
}

const installShutdown = ({ args, homeDir, interactive, rl, runner, processes, hub, web, shell, handleLine, print }: ShutdownOptions): (() => Promise<void>) => {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl?.close();
    runner.stopAll();
    try {
      const stopped = Promise.all([runner.idle(), processes.stopAll(), hub.closeAll()]);
      await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, STOP_TIMEOUT_MS).unref())]);
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
    rl.on("line", line => {
      lines = lines
        .then(() => handleLine(line))
        .then(outcome => {
          if (outcome === "exit") return shutdown();
          if (interactive) rl.prompt();
        })
        .catch(report);
    });
    rl.on("close", () => {
      if (shuttingDown) return;
      void lines.then(() => hub.current?.workspace.current.coordinator.whenIdle()).then(shutdown);
    });
  }
  if (args.serve) {
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  }
  return shutdown;
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  const homeDir = clodexHomeDir();
  const cwd = process.cwd();
  ensureUserConfigTemplate(homeDir);
  // 言語と Web のポートは Hub 全体で 1 つ。project の設定は ProjectContext が読む。
  const hubConfig = loadConfig({ homeDir, projectRoot: homeDir });
  let language = hubConfig.language ?? detectLanguage();
  setLanguage(language);
  const interactive = !args.serve && Boolean(process.stdin.isTTY);
  if (await connectToHub(args, cwd, homeDir, interactive)) return;
  const job = await registerHubJob();
  if (!job.ok) process.stderr.write(`${t("error.jobObject", { message: job.message })}\n`);
  pruneLogs(homeDir);
  const rl =
    args.serve || interactive
      ? undefined
      : createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: PROMPT,
          terminal: false,
          completer: completeCommand,
        });
  const printTerminal = (line: string) => {
    if (interactive) return;
    process.stdout.write(`${line}\n`);
  };
  let displayMode: DisplayMode = "normal";
  let refreshState = () => {};
  const modelCatalog = EMPTY_MODEL_CATALOG();
  const coordinators = new Set<Coordinator>();
  const registerCoordinator = (coordinator: Coordinator) => {
    coordinators.add(coordinator);
    return () => {
      coordinators.delete(coordinator);
    };
  };
  const currentListeners = new Set<(event: CoordinatorEvent) => void>();
  let hub: Hub<ProjectContext>;
  const feed = new WebFeed(DEFAULT_RECENT_ITEMS, item => {
    const context = hub.current;
    if (context) context.saveFeedItem(context.history.currentId, item);
  });
  const push = new PushService(join(homeDir, ".clodex", "push"));
  const notifyAgent = (input: NotificationInput) => {
    const notification = formatNotification(input, MESSAGES[language]);
    feed.publishNotify(notification);
  };
  const notify = (text: string, level: "info" | "warn" = "info") => {
    feed.publishToast(text, level);
    printTerminal(text);
  };
  let pushState: DesktopNotifyState = { live: false, working: false, toolUsed: {} };
  feed.subscribe(item => {
    if (item.type === "notify") {
      if (shouldPushNotification(item.notification.kind))
        push.notify({ title: item.notification.title, body: item.notification.body }).catch((error: unknown) => reportRuntimeError(errorMessage(error)));
      return;
    }
    const update = updateDesktopNotify(pushState, item);
    pushState = update.state;
    const context = hub.current;
    if (update.notification && context)
      notifyAgent({ ...update.notification, projectRoot: context.projectRoot, conversationTitle: context.history.current.title });
  });
  reportRuntimeError = message => {
    const text = t("error.generic", { message });
    feed.publishOutput(text);
    printTerminal(text);
  };
  hub = new Hub({
    homeDir,
    cwd,
    openProject: async projectRoot => {
      let context: ProjectContext;
      context = await openProject({
        projectRoot,
        homeDir,
        args,
        language: () => language,
        printTerminal,
        notify,
        notifyAgent,
        displayMode: () => displayMode,
        isCurrent: () => hub.current === context,
        modelCatalog: () => modelCatalog,
        registerCoordinator,
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
      context.workspace.onRecoveryChange(() => {
        if (hub.current === context) refreshState();
      });
      context.bindFeed(feed, () => hub.current === context);
      await context.restore();
      void context
        .probe()
        .then(() => refreshState())
        .catch((error: unknown) => notify(errorMessage(error), "warn"));
      return context;
    },
  });

  const openInHub = async (path: string): Promise<ProjectContext> => {
    const context = await selectProject(hub, feed, path);
    refreshState();
    return context;
  };
  const initial = initialProject(args, cwd, hub.lastProject);
  for (const project of hub.recoveryProjects().filter(project => project !== initial)) await openInHub(project);
  if (initial) await openInHub(initial);

  const print = (line: string, command?: CommandLifecycle) => {
    feed.publishOutput(line, command);
    printTerminal(line);
  };
  const toggleVerbose = () => {
    displayMode = displayMode === "verbose" ? "normal" : "verbose";
    return displayMode === "verbose";
  };
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
    print,
    notify,
    toggleVerbose,
    runner,
    processes,
    projects: {
      list: () => hub.list(),
      open: openInHub,
      hasCurrent: () => hub.current !== undefined,
      findConversation: (path, id) => hub.conversation(path, id, context => context.history),
      unpinConversation: (path, id) => {
        const pinned = hub.unpinConversation(path, id, context => context.history);
        refreshState();
        return pinned;
      },
      togglePin: path => {
        const pinned = hub.togglePin(path);
        refreshState();
        return pinned;
      },
      remove: path => {
        const error = hub.remove(path);
        refreshState();
        return error;
      },
    },
    language: {
      get: () => language,
      set: next => {
        saveUserLanguage(homeDir, next);
        language = next;
        setLanguage(next);
        web?.updatePage(buildWebPage(next));
      },
    },
    roles: () => current().config.roles ?? {},
    worktreeSetup: () => current().config.worktree?.setup,
    saveRole: (agent, text) => {
      const context = current();
      const saved = saveProjectRole(context.projectRoot, agent, text);
      context.config.roles = { ...context.config.roles, [agent]: saved };
      return saved;
    },
    busyElsewhere: () => current().workspace.busyElsewhereInSameDir(),
    resolveReference: path => current().currentPreview().locate(path),
    sandbox: {
      enabled: () => current().sandbox.enabled,
      ready: () => current().sandbox.ready(),
      set: enabled => current().sandbox.setEnabled(enabled),
      uninstall: async () => {
        const selected = current();
        await uninstallSandboxes(
          selected.sandbox,
          hub.allProjects().map(context => context.sandbox),
        );
        resetSandboxSettings(homeDir);
      },
    },
    limits: {
      get: () => current().limits,
      unlimited: () => current().unlimited,
      set: (name, value) => current().setLimit(name, value),
      reset: () => current().resetLimits(),
      setUnlimited: () => current().setUnlimited(),
    },
    saveSettings: (agents, change) => {
      try {
        current().settingsStore.update(agents, change);
      } catch (error) {
        print(t("error.settingsSave", { message: errorMessage(error) }));
      }
    },
  });
  const { refreshState: requestState } = connectWebFeed(
    {
      subscribe: listener => {
        currentListeners.add(listener);
        return () => currentListeners.delete(listener);
      },
    },
    feed,
    () => {
      const context = hub.current;
      const runtime = context?.workspace.currentIfReady;
      return {
        language,
        sandbox: { enabled: context?.sandbox.enabled ?? false, ready: context?.sandbox.setupReady ?? false },
        limits: buildLimitState(context?.limits, context?.config.limits),
        limitsUnlimited: context?.unlimited ?? false,
        project: runtime?.workDir ?? context?.projectRoot ?? "",
        projects: hub.list(),
        tabs: hub.tabs(project => {
          const withActivity = (conversation: typeof project.history.current) => {
            const activity = project.workspace.activity(conversation.id);
            return { ...conversation, ...(activity ? { activity } : {}) };
          };
          return { conversations: project.history.list().map(withActivity), current: withActivity(project.history.current) };
        }),
        primary: shell.getPrimary(),
        roles: context?.config.roles ?? {},
        rolePreset: matchingRolePreset(context?.config.roles ?? {}),
        agents: runtime?.coordinator.status() ?? [],
        questions: runtime?.coordinator.pendingQuestions() ?? [],
        pendingInputs: runtime?.coordinator.pendingInputs() ?? [],
        pendingMessages: runtime?.coordinator.pendingMessages() ?? [],
        processes: processes.list().map(({ id, command, status }) => ({ id, command, status })),
        conversations:
          context?.history.list().map(conversation => {
            const activity = context.workspace.activity(conversation.id);
            return { ...conversation, current: conversation.id === context.history.currentId, ...(activity ? { activity } : {}) };
          }) ?? [],
      };
    },
    () => language,
  );
  refreshState = requestState;
  refreshState();

  const handleLine = async (line: string) => {
    const outcome = await shell.handleLine(line);
    refreshState();
    return outcome;
  };
  const web = await startWeb({
    args,
    hasWebConfig: hubConfig.web !== undefined,
    configuredPort: hubConfig.web?.port,
    homeDir,
    feed,
    hub,
    current,
    language: () => language,
    onInput: async line => {
      if ((await handleLine(line)) === "exit") void shutdown();
    },
    onError: error => print(t("error.generic", { message: errorMessage(error) })),
    push,
  });
  printStartup(args, hub, homeDir, printTerminal);
  if (web) printTerminal(t("start.web", { url: web.url }));
  const shutdown = installShutdown({ args, homeDir, interactive, rl, runner, processes, hub, web, shell, handleLine, print });
  if (interactive) {
    await startTui(
      createLocalFeedClient(
        feed,
        async line => {
          await handleLine(line);
        },
        () => (hub.current ? listProjectFiles(hub.current.workspace.current.workDir) : Promise.resolve([])),
      ),
    );
    await shutdown();
  }
};

main().catch(runtimeErrors.fatal);
