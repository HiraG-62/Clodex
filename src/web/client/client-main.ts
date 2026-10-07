import type { WEB_LAYOUT } from "../layout.js";
import type { CommandStarts, PendingDeadlines, PendingSettings, resolvePendingSettings as ResolvePendingSettings, isNavigationCommand as IsNavigationCommand, nextCommandStarts as NextCommandStarts } from "./pending.js";
// Web UI の画面の振る舞い（DESIGN.md §17 Web UI）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない 1 つの関数として書く（型の import のみ）。
// 純関数（renderMarkdown 等）とコマンドの一覧は引数で受け取る
import type { AgentId, AgentStatus, TurnResult } from "../../agents/agent-adapter.js";
import type { AgentState } from "../../cli/shell.js";
import type { isShellInput as IsShellInput } from "./shell-input.js";
import type { FeedItem, HistoryItem, HistoryPage, WebState } from "../web-feed.js";
import type { renderMarkdown as RenderMarkdown } from "./markdown.js";
import type { TimelineItem, DisplayTimelineItem, withStartingTurns as WithStartingTurns, applyFeedItem as ApplyFeedItem, rebuildTimeline as RebuildTimeline } from "./timeline.js";
import type { composeInputLine as ComposeInputLine } from "./compose-input.js";
import type { isSendKey as IsSendKey, SendKey } from "./send-key.js";
import type { SlashCommand } from "../../cli/commands.js";
import type { Suggestion, createInputAssist as CreateInputAssist } from "./input-assist.js";
import type { collectArtifacts as CollectArtifacts, displayPath as DisplayPath, findImagePaths as FindImagePaths } from "./artifacts.js";
import type { MessageKey, Messages } from "../../i18n/messages.js";
import type { chooseProjectPath as ChooseProjectPath } from "./project-picker.js";
import type { DesktopNotification, DesktopNotifyState, updateDesktopNotify as UpdateDesktopNotify } from "./desktop-notify.js";

export interface ClientDeps {
  layout: typeof WEB_LAYOUT;
  withStartingTurns: typeof WithStartingTurns;
  resolvePendingSettings: typeof ResolvePendingSettings;
  isNavigationCommand: typeof IsNavigationCommand;
  nextCommandStarts: typeof NextCommandStarts;
  isShellInput: typeof IsShellInput;
  renderMarkdown: typeof RenderMarkdown;
  applyFeedItem: typeof ApplyFeedItem;
  rebuildTimeline: typeof RebuildTimeline;
  composeInputLine: typeof ComposeInputLine;
  isSendKey: typeof IsSendKey;
  createInputAssist: typeof CreateInputAssist;
  collectArtifacts: typeof CollectArtifacts;
  findImagePaths: typeof FindImagePaths;
  displayPath: typeof DisplayPath;
  commands: readonly SlashCommand[];
  messages: Messages;
  chooseProjectPath: typeof ChooseProjectPath;
  updateDesktopNotify: typeof UpdateDesktopNotify;
  version: string;
}

export function clientMain({
  layout, withStartingTurns, resolvePendingSettings, isNavigationCommand, nextCommandStarts, renderMarkdown, applyFeedItem, rebuildTimeline, composeInputLine, isSendKey, createInputAssist, collectArtifacts, findImagePaths, displayPath, commands, messages, chooseProjectPath, version, isShellInput, updateDesktopNotify,
}: ClientDeps): void {
  // 画面の言語の文言（i18n/i18n.ts の format と同じ置き換え）
  const t = (key: MessageKey, params: Record<string, string | number> = {}) =>
    messages[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
  const AGENTS: Record<AgentId, { name: string; mark: string }> = {
    claude: { name: "Claude", mark: "C" },
    codex: { name: "Codex", mark: "X" },
  };
  const AGENT_IDS: AgentId[] = ["claude", "codex"];
  const PERMISSIONS = ["read-only", "edit", "full"] as const;
  const EFFORTS: Record<AgentId, readonly string[]> = {
    claude: ["low", "medium", "high", "xhigh", "max"],
    codex: ["minimal", "low", "medium", "high", "xhigh"],
  };
  const THEMES = ["system", "light", "dark"] as const;
  type Theme = (typeof THEMES)[number];
  const THEME_LABEL: Record<Theme, MessageKey> = { system: "web.settings.themeSystem", light: "web.settings.themeLight", dark: "web.settings.themeDark" };
  const STATUS_LABEL: Record<AgentStatus, MessageKey> = { busy: "web.status.busy", idle: "web.status.idle", starting: "web.status.starting", stopped: "web.status.stopped" };
  const TURN_LABEL: Record<"working" | TurnResult["status"], MessageKey | undefined> = { working: "web.status.busy", interrupted: "web.turn.interrupted", failed: "web.turn.failed", completed: undefined };
  const MOBILE_QUERY = "(max-width: 899px), (pointer: coarse)";
  const mobile = window.matchMedia(MOBILE_QUERY);
  const wideUsage = window.matchMedia(`(min-width: ${layout.wideUsageMinWidth}px) and (hover: hover) and (pointer: fine)`);
  const SWIPE_CLOSE_PX = 72;
  const KEYBOARD_THRESHOLD_PX = 120;
  const CODE_FOLD_LINES = 8;
  const USAGE_POPOVER_GAP_PX = 8;
  const NEAR_BOTTOM_PX = 120;
  const HISTORY_THRESHOLD_PX = 200;
  const TOAST_DURATION_MS = 4000;
  const MAX_TOASTS = 3;
  const RELOAD_DELAY_MS = 350;
  const SETTING_TIMEOUT_MS = 5_000;
  const INTERRUPT_RETRY_MS = 5_000;
  const TOAST_EXIT_MS = 150;
  const TOKENS_PER_K = 1000;
  const MS_PER_SECOND = 1000;
  const SECONDS_PER_MINUTE = 60;
  const PERCENT = 100;
  // @path の候補を取り直す間隔（入力欄に入るたびに取ると重い）
  const FILES_REFRESH_MS = 30_000;
  // @path の参照として本文の末尾に足された部分（cli/file-references.ts）。編集で入力欄に戻すときは外す
  const REFERENCES_SEPARATOR = "\n\nReferenced files:\n";
  const ARTIFACT_LABEL: Record<"changed" | "referenced" | "image", MessageKey> = { changed: "web.artifact.changed", referenced: "web.artifact.referenced", image: "web.artifact.image" };
  const THEME_KEY = "clodex-theme";
  const SEND_KEY_KEY = "clodex-send-key";
  const SEND_KEYS: readonly SendKey[] = ["enter", "ctrlEnter"];
  const DETAIL_KEY = "clodex-detail";

  const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
  const el = (tag: string, className?: string, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name: string) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "i");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  };
  const iconButton = (name: string, label: string, cls = "") => {
    const button = el("button", `icon-btn ${cls}`) as HTMLButtonElement;
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(icon(name));
    return button;
  };
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const clock = (iso: string) => {
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const shortDate = (iso: string) => {
    const d = new Date(iso);
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${clock(iso)}`;
  };
  const kTokens = (n: number) => `${Math.round(n / TOKENS_PER_K)}k`;
  const storage = {
    get: (key: string) => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 保存できなくても動く */ } },
  };
  const mark = (agent: AgentId | "you") => {
    const node = el("span", `mark ${agent}`, agent === "you" ? "Y" : AGENTS[agent].mark);
    node.setAttribute("aria-hidden", "true");
    return node;
  };

  // ---- 状態 ----
  let items: TimelineItem[] = [];
  let history: HistoryItem[] = [];
  let historyHasMore = true;
  let historyLoading = false;
  let historyGeneration = 0;
  const questionDrafts = new Map<string, { selected: Set<number>[]; other: string[] }>();
  let state: WebState | undefined;
  let pendingSettings: PendingSettings = {};
  let pendingDeadlines: PendingDeadlines = {};
  const settingRequests = new Map<string, symbol>();
  let reloading = false;
  const pendingRequests = new Set<string>();
  const interrupting = new Set<AgentId>();
  const interruptAttempts = new Map<AgentId, symbol>();
  let uploading = 0;
  let commandStarts: CommandStarts = {};
  const startingAt = new Map<AgentId, string>();
  let replaying = true;
  let incomingHistory: HistoryItem[] = [];
  let replayScheduled = false;
  let liveGeneration = 0;
  let detail = storage.get(DETAIL_KEY) === "1";
  let target: AgentId | undefined; // undefined なら primary に送る
  const opened = new Map<string, boolean>(); // 人が開閉した details の状態（項目 ID ごと）
  const rendered = new Map<string, { item: DisplayTimelineItem; node: HTMLElement }>();
  const controlUpdaters = new WeakMap<HTMLElement, (agent: AgentState) => void>();

  const log = $("#log");
  const newer = $("#newer");
  const input = document.querySelector<HTMLTextAreaElement>("#input")!;

  // ---- 送信 ----
  // 送れたら true。失敗したら理由をトーストで出す
  const setPending = (button: HTMLButtonElement, pending: boolean) => {
    if (pending && !button.classList.contains("is-loading")) button.dataset.wasDisabled = String(button.disabled);
    if (!pending && button.classList.contains("is-loading")) button.disabled = button.dataset.wasDisabled === "true";
    if (pending) button.disabled = true;
    button.classList.toggle("is-loading", pending);
    button.setAttribute("aria-busy", String(pending));
  };
  const syncPendingButtons = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-command]")) {
      const line = button.dataset.command ?? "";
      const agent = line.split(" ")[1] as AgentId;
      setPending(button, pendingRequests.has(line) || (line.startsWith("/interrupt ") && interrupting.has(agent)));
      if (line.startsWith("/interrupt ") && state?.agents.find((entry) => entry.id === agent)?.status !== "busy") button.disabled = true;
    }
    $(".app").classList.toggle("navigation-pending", [...pendingRequests].some(isNavigationCommand));
  };
  const withPending = async <T>(button: HTMLButtonElement | undefined, operation: () => Promise<T>): Promise<T> => {
    if (button) setPending(button, true);
    try { return await operation(); }
    finally { if (button) setPending(button, false); }
  };
  const send = async (line: string, button?: HTMLButtonElement): Promise<boolean> => {
    if (pendingRequests.has(line)) return false;
    pendingRequests.add(line);
    if (button) button.dataset.command = line;
    const stoppedAgent = line.startsWith("/interrupt ") ? line.split(" ")[1] as AgentId : undefined;
    const interruptAttempt = Symbol();
    if (stoppedAgent) { interrupting.add(stoppedAgent); interruptAttempts.set(stoppedAgent, interruptAttempt); }
    syncPendingButtons();
    try {
      return await withPending(button, async () => {
        try {
          const response = await fetch("/api/input", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ line }),
          });
          if (response.ok) return true;
          showToast(t("web.send.failedStatus", { status: response.status }));
        } catch { showToast(t("web.send.failed")); }
        if (stoppedAgent) interrupting.delete(stoppedAgent);
        return false;
      });
    } finally {
      if (stoppedAgent && interrupting.has(stoppedAgent)) {
        const generation = liveGeneration;
        window.setTimeout(() => {
          if (generation !== liveGeneration || pendingRequests.has(line) || interruptAttempts.get(stoppedAgent) !== interruptAttempt) return;
          interrupting.delete(stoppedAgent);
          syncPendingButtons();
        }, INTERRUPT_RETRY_MS);
      }
      pendingRequests.delete(line);
      syncPendingButtons();
    }
  };
  const requestSetting = async (id: AgentId, key: "model" | "effort" | "permission", value: string, button?: HTMLButtonElement) => {
    if (pendingSettings[id]?.[key] !== undefined) return false;
    const generation = liveGeneration;
    const requestKey = `${id}:${key}`;
    const request = Symbol();
    settingRequests.set(requestKey, request);
    pendingSettings[id] = { ...pendingSettings[id], [key]: value };
    delete pendingDeadlines[id]?.[key];
    renderState();
    const sent = await send(`/${key} ${id} ${value}`, button);
    if (generation !== liveGeneration || settingRequests.get(requestKey) !== request) return false;
    if (!sent) {
      delete pendingSettings[id]?.[key];
      renderState();
    } else if (pendingSettings[id]?.[key] === value) {
      const deadline = Date.now() + SETTING_TIMEOUT_MS;
      pendingDeadlines[id] = { ...pendingDeadlines[id], [key]: deadline };
      window.setTimeout(() => {
        if (generation !== liveGeneration || pendingDeadlines[id]?.[key] !== deadline) return;
        pendingSettings = resolvePendingSettings(pendingSettings, state?.agents ?? [], pendingDeadlines);
        renderState();
      }, SETTING_TIMEOUT_MS);
    }
    refreshOpenSheet();
    return sent;
  };
  const displayedAgent = (agent: AgentState): AgentState => ({
    ...agent, ...pendingSettings[agent.id],
    ...(pendingSettings[agent.id]?.model ? { modelLabel: pendingSettings[agent.id]!.model } : {}),
  });

  // ---- テーマ ----
  const applyTheme = (theme: Theme) => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  };
  let theme = (THEMES as readonly string[]).includes(storage.get(THEME_KEY) ?? "") ? storage.get(THEME_KEY) as Theme : "system";
  let sendKey: SendKey = (SEND_KEYS as readonly string[]).includes(storage.get(SEND_KEY_KEY) ?? "") ? storage.get(SEND_KEY_KEY) as SendKey : "enter";
  applyTheme(theme);
  const THEME_ICON: Record<Theme, string> = { system: "monitor", light: "sun", dark: "moon" };
  const syncThemeButton = (button: HTMLButtonElement, text: boolean) => {
    const label = t("web.settings.themeCurrent", { theme: t(THEME_LABEL[theme]) });
    button.title = label;
    button.setAttribute("aria-label", label);
    button.replaceChildren(icon(THEME_ICON[theme]));
    if (text) button.append(el("span", "", label));
  };
  const cycleTheme = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
    storage.set(THEME_KEY, theme);
    applyTheme(theme);
    syncThemeButton($("#cycle-theme"), false);
    const menuButton = document.querySelector<HTMLButtonElement>("#mobile-theme");
    if (menuButton) syncThemeButton(menuButton, true);
  };
  syncThemeButton($("#cycle-theme"), false);
  $("#cycle-theme").addEventListener("click", cycleTheme);

  // ---- トースト ----
  const showToast = (text: string, level: "info" | "warn" = "info") => {
    const container = $("#toast");
    const toast = el("button", `toast-item ${level}`);
    toast.append(icon(level === "warn" ? "alert" : "check-circle"), el("span", "", text), icon("x"));
    toast.setAttribute("aria-label", `${text} · ${t("web.sheet.close")}`);
    toast.title = t("web.sheet.close");
    const dismiss = () => { toast.classList.add("leaving"); window.setTimeout(() => toast.remove(), TOAST_EXIT_MS); };
    container.append(toast);
    const timer = window.setTimeout(dismiss, TOAST_DURATION_MS);
    toast.addEventListener("click", () => { window.clearTimeout(timer); dismiss(); });
    while (container.children.length > MAX_TOASTS) container.firstElementChild?.remove();
  };

  // ---- ログの描画 ----
  const details = (id: string, summary: string, body: HTMLElement, cls: string) => {
    const node = el("details", cls) as HTMLDetailsElement;
    node.open = opened.get(id) ?? detail;
    node.append(el("summary", "", summary), body);
    node.addEventListener("toggle", () => opened.set(id, node.open));
    return node;
  };

  // tool 名を短い種類にする（Claude: Read / Bash / mcp__clodex__send_message、Codex: command / clodex.send_message）
  const toolLabel = (name: string) => {
    if (name.includes("send_message")) return "send";
    if (name === "command" || name === "Bash" || name === "PowerShell") return "run";
    const short = name.replace(/^mcp__/, "").toLowerCase();
    return short.length > 8 ? `${short.slice(0, 7)}…` : short;
  };

  // 作業中のターンの経過時間（1 秒ごとに書き換える）
  const elapsedText = (startIso: string) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / MS_PER_SECOND));
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    return minutes ? t("web.elapsed.minutes", { minutes, seconds: seconds % SECONDS_PER_MINUTE }) : t("web.elapsed.seconds", { seconds });
  };
  // 今の作業: 直近の発言か tool を 1 行で（DESIGN.md §17 ログ）
  const nowLine = (item: Extract<TimelineItem, { kind: "turn" }>) => {
    const node = el("div", "now");
    const last = item.steps[item.steps.length - 1];
    if (!last) node.append(el("span", "what muted", t("web.turn.working")));
    else if (last.kind === "say") node.append(el("span", "what", last.text.split("\n", 1)[0] ?? ""));
    else node.append(el("span", "k", toolLabel(last.name)), el("span", "what mono", last.input));
    return node;
  };

  const appendImagePreviews = (node: HTMLElement, text: string) => {
    const paths = findImagePaths(text);
    if (!paths.length) return;
    const previews = el("div", "image-previews");
    for (const path of paths) {
      const button = el("button", "image-preview") as HTMLButtonElement;
      button.type = "button";
      const image = document.createElement("img");
      image.alt = displayPath(path, state?.project ?? "");
      image.loading = "lazy";
      image.addEventListener("error", () => button.remove());
      image.src = fileUrl("file", path);
      button.addEventListener("click", () => void openViewer(path));
      button.append(image);
      previews.append(button);
    }
    node.append(previews);
  };

  const renderTurn = (item: Extract<TimelineItem, { kind: "turn" }>) => {
    const node = el("article", "entry");
    node.append(mark(item.agent));
    const head = el("div", "head");
    head.append(el("b", `c-${item.agent}`, AGENTS[item.agent].name), el("time", "mono", clock(item.at)));
    const label = TURN_LABEL[item.status];
    if (label) head.append(el("span", `state ${item.status}`, t(label)));
    if (item.status === "working") {
      const elapsed = el("span", "elapsed mono", elapsedText(item.at));
      elapsed.dataset.start = item.at;
      head.append(elapsed);
    }
    node.append(head);
    if (item.plan) {
      const plan = el("div", "plan md");
      plan.innerHTML = renderMarkdown(item.plan);
      node.append(plan);
    }
    if (item.steps.length) {
      const list = el("ol");
      for (const step of item.steps) {
        const li = el("li");
        if (step.kind === "say") li.append(el("span", "k", "say"), el("span", "say", step.text));
        else li.append(el("span", "k", toolLabel(step.name)), el("span", "run", step.input));
        list.append(li);
      }
      node.append(details(item.id, t("web.turn.steps", { count: item.steps.length }), list, "steps"));
    }
    if (item.status === "working") node.append(nowLine(item));
    const body = el("div", "body md");
    if (item.text) body.innerHTML = renderMarkdown(item.text);
    else if (item.status === "completed") body.append(el("span", "muted", t("web.turn.completed")));
    if (body.childNodes.length) node.append(body);
    appendImagePreviews(node, item.text);
    return node;
  };

  const renderMessage = (item: Extract<TimelineItem, { kind: "message" }>) => {
    const { message } = item;
    const node = el("section", "handoff");
    const route = el("div", "route");
    route.append(mark(message.from), el("span", "arrow", "→"), mark(message.to), el("span", "kind", message.type));
    if (message.status) route.append(el("span", "kind", message.status.replace(/_/g, " ").toUpperCase()));
    if (message.interrupt) route.append(el("span", "kind steer", t("web.steer")));
    route.append(el("span", "task mono", `${message.taskId} · ${clock(item.at)}`));
    const text = el("div", "text md");
    text.innerHTML = renderMarkdown(message.body);
    node.append(route, text);
    appendImagePreviews(node, message.body);
    if (message.spec || message.files?.length) {
      const refs = el("div", "refs");
      if (message.spec) {
        const spec = message.spec;
        const ref = el("button", "ref spec", `${t("web.message.spec")}: ${spec}`) as HTMLButtonElement;
        ref.type = "button";
        ref.addEventListener("click", () => void openViewer(spec));
        refs.append(ref);
      }
      for (const file of message.files ?? []) {
        const ref = el("button", "ref", file) as HTMLButtonElement;
        ref.type = "button";
        ref.addEventListener("click", () => void openViewer(file));
        refs.append(ref);
      }
      node.append(refs);
    }
    for (const issue of message.issues ?? []) {
      const finding = el("div", `finding ${issue.severity}`);
      finding.append(el("span", "sev", issue.severity), el("span", "loc", issue.line ? `${issue.file}:${issue.line}` : issue.file), el("span", "desc", issue.summary));
      node.append(finding);
    }
    if (item.envelope) node.append(details(item.id, t("web.message.envelope", { agent: AGENTS[message.to].name }), el("pre", "", item.envelope), "envelope"));
    return node;
  };

  const renderQuestion = (item: Extract<TimelineItem, { kind: "question" }>): HTMLElement => {
    const node = el("article", `entry question ${item.agent}`);
    const head = el("div", "head");
    head.append(el("b", `c-${item.agent}`, AGENTS[item.agent].name), el("time", "mono", clock(item.at)));
    node.append(mark(item.agent), head);
    const card = el("div", "question-card");
    const heading = el("div", "question-card-title");
    heading.append(icon("question"), el("span", "", t(item.answers ? "web.question.answered" : "web.question.title")));
    card.append(heading);
    node.append(card);
    const draft = questionDrafts.get(item.id) ?? { selected: item.questions.map(() => new Set<number>()), other: item.questions.map(() => "") };
    if (!item.answers) questionDrafts.set(item.id, draft);
    else questionDrafts.delete(item.id);
    const submit = el("button", "question-submit", t(item.answers ? "web.question.answered" : "web.question.answer")) as HTMLButtonElement;
    submit.type = "button";
    const answers = () => item.questions.map((question, index) => [
      ...question.options.filter((_option, optionIndex) => draft.selected[index]!.has(optionIndex)).map((option) => option.label),
      ...(draft.other[index]?.trim() ? [draft.other[index]!.trim()] : []),
    ]);
    let submitting = false;
    const refreshSubmit = () => { submit.disabled = submitting || Boolean(item.answers) || answers().some((answer) => !answer.length); };
    for (const [index, question] of item.questions.entries()) {
      const field = el("div", "question-field");
      if (question.header) field.append(el("span", "kind", question.header));
      field.append(el("p", "question-text", question.question));
      const options = el("div", "question-options");
      const other = el("input", "question-other") as HTMLInputElement;
      other.type = "text";
      other.placeholder = t("web.question.other");
      other.setAttribute("aria-label", t("web.question.other"));
      other.disabled = Boolean(item.answers);
      other.value = item.answers ? (item.answers[index] ?? []).filter((answer) => !question.options.some((option) => option.label === answer)).join(", ") : draft.other[index] ?? "";
      const buttons: HTMLButtonElement[] = [];
      const refreshOptions = () => {
        buttons.forEach((button, optionIndex) => {
          const selected = item.answers ? item.answers[index]?.includes(question.options[optionIndex]!.label) : draft.selected[index]!.has(optionIndex);
          button.classList.toggle("selected", Boolean(selected));
          button.setAttribute("aria-pressed", String(Boolean(selected)));
        });
        refreshSubmit();
      };
      question.options.forEach((option, optionIndex) => {
        const button = el("button", "question-option") as HTMLButtonElement;
        button.type = "button";
        button.disabled = Boolean(item.answers);
        button.append(el("span", "", option.label));
        if (option.description) button.append(el("small", "muted", option.description));
        button.addEventListener("click", () => {
          const selected = draft.selected[index]!;
          const wasSelected = selected.has(optionIndex);
          if (!question.multiSelect) { selected.clear(); draft.other[index] = ""; other.value = ""; }
          if (wasSelected) selected.delete(optionIndex); else selected.add(optionIndex);
          refreshOptions();
        });
        buttons.push(button);
        options.append(button);
      });
      other.addEventListener("input", () => {
        draft.other[index] = other.value;
        if (!question.multiSelect && other.value.trim()) draft.selected[index]!.clear();
        refreshOptions();
      });
      refreshOptions();
      const footer = el("div", "question-footer");
      footer.append(other);
      field.append(options, footer);
      if (item.answers) field.append(el("p", "question-answered", (item.answers[index] ?? []).join(", ")));
      card.append(field);
    }
    submit.addEventListener("click", async () => {
      submitting = true;
      refreshSubmit();
      await send(`/answer ${item.id} ${JSON.stringify(answers())}`, submit);
      submitting = false;
      refreshSubmit();
    });
    refreshSubmit();
    const footer = [...card.querySelectorAll(".question-footer")].at(-1);
    (footer ?? card).append(submit);
    return node;
  };

  const renderItem = (item: DisplayTimelineItem): HTMLElement => {
    switch (item.kind) {
      case "starting": {
        const node = el("article", "entry starting-turn");
        node.append(mark(item.agent));
        const head = el("div", "head");
        const elapsed = el("span", "elapsed mono", elapsedText(item.at));
        elapsed.dataset.start = item.at;
        head.append(el("b", `c-${item.agent}`, AGENTS[item.agent].name), el("span", "state starting", t("web.turn.starting")), elapsed);
        const body = el("div", "body");
        body.setAttribute("aria-hidden", "true");
        body.append(el("span", "sk"), el("span", "sk"));
        node.append(head, body);
        return node;
      }
      case "human": {
        const node = el("article", "entry you");
        const head = el("div", "head");
        head.append(el("b", "", t("web.you")), el("span", `c-${item.agent}`, `→ ${AGENTS[item.agent].name}`), el("time", "mono", clock(item.at)));
        if (item.steer) {
          head.append(el("span", "kind steer", t("web.steer")),
            el("span", item.delivered ? "steer-state delivered" : "steer-state", t(item.delivered ? "web.steer.delivered" : "web.steer.sent")));
        }
        const body = el("div", "body md");
        body.innerHTML = renderMarkdown(item.text);
        node.append(mark("you"), head, body);
        appendImagePreviews(node, item.text);
        return node;
      }
      case "question": return renderQuestion(item);
      case "turn": return renderTurn(item);
      case "message": return renderMessage(item);
      case "notice": return el("div", "notice", item.text);
      case "error": return el("div", "error-row", `${AGENTS[item.agent].name}: ${item.text}`);
      case "output": return el("pre", "output", item.text);
    }
  };

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM_PX;
  const scrollToBottom = () => {
    log.scrollTop = log.scrollHeight;
    newer.hidden = true;
  };

  const workingPanel = $("#working-panel");
  const workingToggle = $("#working-toggle");
  const questionToggle = $("#question-toggle");
  const renderQuestionCount = () => {
    const count = state?.questions.length ?? 0;
    questionToggle.hidden = count === 0;
    questionToggle.replaceChildren(icon("question"), ...(mobile.matches ? [el("span", "mobile-tab-label", t("web.question.title"))] : []), el("span", "count", String(count)));
    questionToggle.setAttribute("aria-label", `${t("web.question.title")} ${count}`);
  };
  questionToggle.addEventListener("click", () => {
    const oldest = state?.questions[0];
    if (oldest) rendered.get(oldest.id)?.node.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  const renderWorking = () => {
    const active = items.filter((item): item is Extract<TimelineItem, { kind: "turn" }> => item.kind === "turn" && item.status === "working");
    $("#working-count").textContent = String(active.length);
    workingToggle.dataset.agent = active.length > 1 ? state?.primary ?? "claude" : active[0]?.agent ?? "claude";
    workingToggle.hidden = active.length === 0;
    if (!active.length) { workingPanel.hidden = true; workingToggle.setAttribute("aria-expanded", "false"); }
    const list = $("#working-list");
    list.replaceChildren(...active.map((item) => {
      const last = item.steps.at(-1);
      const work = last?.kind === "say" ? last.text : last?.kind === "tool" ? `${last.name}: ${last.input}` : t("web.turn.working");
      const button = el("button", "working-entry") as HTMLButtonElement;
      button.type = "button";
      button.append(el("span", `name c-${item.agent}`, AGENTS[item.agent].name));
      if (item.plan) button.append(el("span", "plan", item.plan.split("\n", 1)[0] ?? ""));
      button.append(el("span", "work", work.split("\n", 1)[0] ?? ""));
      const elapsed = el("span", "elapsed", elapsedText(item.at));
      elapsed.dataset.start = item.at;
      button.append(elapsed);
      button.addEventListener("click", () => {
        workingPanel.hidden = true;
        workingToggle.setAttribute("aria-expanded", "false");
        rendered.get(item.id)?.node.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return button;
    }));
    if (!active.length) list.append(el("p", "muted small", t("web.working.empty")));
  };
  workingToggle.addEventListener("click", () => {
    workingPanel.hidden = !workingPanel.hidden;
    workingToggle.setAttribute("aria-expanded", String(!workingPanel.hidden));
  });
  $("#working-close").addEventListener("click", () => {
    workingPanel.hidden = true;
    workingToggle.setAttribute("aria-expanded", "false");
  });

  const enhanceMarkdown = (root: HTMLElement) => {
    for (const pre of root.querySelectorAll("pre")) {
      if (pre.parentElement?.classList.contains("code-block")) continue;
      const code = pre.querySelector("code");
      if (!code) continue;
      const text = code.textContent ?? "";
      const block = el("div", `code-block${text.trimEnd().split("\n").length > CODE_FOLD_LINES ? " long" : ""}`);
      const head = el("div", "code-head");
      const copy = iconButton("copy", t("web.code.copy"));
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(text); showToast(t("web.code.copied")); }
        catch { showToast(t("web.code.copyFailed")); }
      });
      head.append(copy);
      pre.before(block);
      block.append(head, pre);
      if (block.classList.contains("long")) {
        const more = iconButton("chevron-down", t("web.code.full"), "code-more");
        more.append(el("span", "", t("web.code.full")));
        more.setAttribute("aria-expanded", "false");
        more.addEventListener("click", () => {
          const expanded = block.classList.toggle("expanded");
          more.setAttribute("aria-expanded", String(expanded));
          const label = t(expanded ? "web.code.collapse" : "web.code.full");
          more.setAttribute("aria-label", label);
          more.title = label;
          more.querySelector("span")!.textContent = label;
        });
        block.append(more);
      }
    }
    for (const table of root.querySelectorAll("table")) {
      if (table.parentElement?.classList.contains("table-scroll")) continue;
      const scroll = el("div", "table-scroll");
      scroll.tabIndex = 0;
      table.before(scroll);
      scroll.append(table);
    }
  };

  // 変わった項目だけ描き直す（開閉やスクロール位置を保つ）
  const renderLog = (force = false) => {
    const stick = nearBottom();
    const visibleItems = withStartingTurns(items, state?.agents ?? [], new Date().toISOString(), state?.pendingInputs ?? []);
    items = visibleItems.filter((item): item is TimelineItem => item.kind !== "starting");
    let changed = false;
    for (const item of visibleItems) {
      if (item.kind !== "starting") continue;
      if (!startingAt.has(item.agent)) startingAt.set(item.agent, item.at);
      item.at = startingAt.get(item.agent)!;
    }
    for (const id of AGENT_IDS) if (!visibleItems.some((item) => item.kind === "starting" && item.agent === id)) startingAt.delete(id);
    const keep = new Set(visibleItems.map((i) => i.id));
    for (const [id, entry] of rendered) {
      if (!keep.has(id)) {
        entry.node.remove();
        rendered.delete(id);
      }
    }
    let previous: HTMLElement | undefined;
    for (const item of visibleItems) {
      const current = rendered.get(item.id);
      let node = current?.node;
      const sameStarting = current?.item.kind === "starting" && item.kind === "starting" && current.item.at === item.at;
      if (!current || (current.item !== item && !sameStarting) || force) {
        changed = true;
        node = renderItem(item);
        if (current) current.node.replaceWith(node);
        rendered.set(item.id, { item, node });
      }
      // まだ DOM に無い要素、または位置がずれた要素を、直前の要素の後ろへ置く
      if (node && (node.parentNode !== log || node.previousElementSibling !== (previous ?? null))) {
        if (previous) previous.after(node); else log.prepend(node);
      }
      previous = node;
    }
    $("#empty").hidden = !state || visibleItems.length > 0;
    $("#log-skeleton").hidden = Boolean(state);
    const older = $("#history-loading");
    older.hidden = !historyLoading;
    log.prepend(older);
    for (const clock of log.querySelectorAll(".output-clock")) clock.remove();
    for (const [id, commandStart] of Object.entries(commandStarts)) {
      const clockRow = el("div", "output-clock");
      const elapsed = el("span", "elapsed", elapsedText(commandStart.at));
      elapsed.dataset.start = commandStart.at;
      clockRow.dataset.commandId = id;
      clockRow.append(el("span", "spin"), el("span", "", `#${id} · ${t("web.command.running")}`), elapsed);
      rendered.get(commandStart.outputId)?.node.before(clockRow);
    }
    enhanceMarkdown(log);
    if (stick) scrollToBottom(); else if (changed) newer.hidden = false;
    renderWorking();
  };

  // ---- 状態の描画 ----
  const gauge = (label: string, value: string, percent: number | undefined, agent: AgentId, over = false, tick?: number, reset = "") => {
    const node = el("div", "gauge");
    node.append(el("span", "k", label), el("span", `v mono${over ? " over" : ""}`, value));
    node.querySelector<HTMLElement>(".v")!.prepend(el("span", "gauge-reset", reset));
    node.querySelector<HTMLElement>(".v")!.dataset.compact = percent === undefined ? "—" : `${Math.round(percent)}%`;
    const track = el("span", `track ${agent}`);
    const fill = el("i");
    fill.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
    track.append(fill);
    if (tick !== undefined) {
      const marker = el("span", "tick");
      marker.style.left = `${Math.max(0, Math.min(100, tick))}%`;
      marker.title = t("web.gauge.tick");
      track.append(marker);
    }
    node.append(track);
    node.title = `${label}: ${value}`;
    node.dataset.label = label === t("web.gauge.context") ? "ctx" : label.split(" · ")[0]?.split("（")[0]?.split(" (")[0] ?? label;
    node.querySelector<HTMLElement>(".k")!.textContent = label.split(" · ")[0]?.split("（")[0]?.split(" (")[0] ?? label;
    return node;
  };

  const syncGauge = (node: HTMLElement, label: string, value: string, percent: number | undefined, over = false, tick?: number, reset = "") => {
    node.title = `${label}: ${value}`;
    node.dataset.label = label === t("web.gauge.context") ? "ctx" : label.split(" · ")[0]?.split("（")[0]?.split(" (")[0] ?? label;
    const key = node.querySelector<HTMLElement>(".k")!;
    const val = node.querySelector<HTMLElement>(".v")!;
    const track = node.querySelector<HTMLElement>(".track")!;
    key.textContent = label.split(" · ")[0]?.split("（")[0]?.split(" (")[0] ?? label;
    val.replaceChildren(el("span", "gauge-reset", reset), document.createTextNode(value));
    val.dataset.compact = percent === undefined ? "—" : `${Math.round(percent)}%`;
    val.classList.toggle("over", over);
    track.querySelector<HTMLElement>("i")!.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
    let marker = track.querySelector<HTMLElement>(".tick");
    if (tick === undefined) { marker?.remove(); return; }
    if (!marker) {
      marker = el("span", "tick");
      marker.title = t("web.gauge.tick");
      track.append(marker);
    }
    marker.style.left = `${Math.max(0, Math.min(100, tick))}%`;
  };

  const resetLabel = (epochSeconds: number | undefined, withDate: boolean) => {
    if (epochSeconds === undefined) return "";
    const iso = new Date(epochSeconds * MS_PER_SECOND).toISOString();
    return t("web.gauge.reset", { time: withDate ? shortDate(iso) : clock(iso) });
  };

  // 利用枠とコンテキストのゲージの表示内容。作るときと更新するときで共有する
  const gaugeValues = (usage: AgentState["usage"]) => {
    const pace = usage.weeklyPace;
    const contextValue = usage.contextTokens === undefined
      ? "—" : `${kTokens(usage.contextTokens)}${usage.contextWindow ? ` / ${kTokens(usage.contextWindow)}` : ""}`;
    return [
      {
        label: `${t("web.gauge.fiveHour")}${resetLabel(usage.fiveHourResetsAt, false)}`,
        value: usage.fiveHourPercent === undefined ? "—" : `${usage.fiveHourPercent}%`,
        percent: usage.fiveHourPercent, over: false, tick: undefined, reset: usage.fiveHourResetsAt === undefined ? "" : clock(new Date(usage.fiveHourResetsAt * MS_PER_SECOND).toISOString()),
      },
      {
        label: `${t("web.gauge.weekly")}${pace === undefined ? "" : t("web.gauge.pace", { pace: `${pace > 0 ? "+" : ""}${pace}` })}${resetLabel(usage.weeklyResetsAt, true)}`,
        value: usage.weeklyPercent === undefined ? "—" : `${usage.weeklyPercent}%`,
        percent: usage.weeklyPercent, over: (pace ?? 0) > 0, reset: usage.weeklyResetsAt === undefined ? "" : shortDate(new Date(usage.weeklyResetsAt * MS_PER_SECOND).toISOString()),
        tick: pace === undefined || usage.weeklyPercent === undefined ? undefined : usage.weeklyPercent - pace,
      },
      {
        label: t("web.gauge.context"), value: contextValue,
        percent: usage.contextTokens && usage.contextWindow ? (usage.contextTokens / usage.contextWindow) * PERCENT : 0,
        over: false, tick: undefined, reset: "",
      },
    ];
  };

  // Agent パネル: 設定の要約、利用枠、操作。権限・model・effort はペンアイコンかチップから開くポップアップで変える
  const agentControls = (agent: AgentState) => {
    const wrap = el("div", "controls");
    wrap.dataset.agent = agent.id;
    const currentStatus = stateLabel(agent);
    currentStatus.classList.add("mobile-only");
    wrap.append(currentStatus);
    const chips = el("div", "setting-chips");
    const chip = (label: string) => {
      const button = el("span", "setting-chip mono", label);
      chips.append(button);
      return button;
    };
    const modelChip = chip(agent.modelLabel ?? agent.model ?? "default");
    const effortChip = chip(agent.effort ?? "default");
    const permissionChip = chip(agent.permission);
    const updateChips = (incoming: AgentState) => {
      const current = displayedAgent(incoming);
      modelChip.textContent = current.modelLabel ?? current.model ?? "default";
      effortChip.textContent = current.effort ?? "default";
      permissionChip.replaceChildren(icon(current.permission === "full" ? "shield-alert" : "shield"), document.createTextNode(current.permission === "full" ? "" : current.permission));
      modelChip.prepend(icon("cpu"));
      effortChip.prepend(icon("gauge"));
      for (const button of [modelChip, effortChip, permissionChip]) {
        button.title = `${button === permissionChip ? current.permission : button.textContent}`;
        button.setAttribute("aria-label", button.title);
      }
      permissionChip.classList.toggle("warning", current.permission === "full");
      const pending = pendingSettings[agent.id];
      for (const [button, key] of [[modelChip, "model"], [effortChip, "effort"], [permissionChip, "permission"]] as const) {
        button.classList.toggle("pending", pending?.[key] !== undefined);
        if (pending?.[key] !== undefined) button.title += ` · ${t("web.setting.pending")}`;
      }
    };
    updateChips(agent);
    const gauges = gaugeValues(agent.usage).map((g) => gauge(g.label, g.value, g.percent, agent.id, g.over, g.tick, g.reset));
    const minis = el("div", "mini-gauges");
    minis.append(...gauges);
    wrap.append(chips, minis);
    const links = el("div", "links");
    const action = (name: string, label: string, run: () => void, cls = "", disabled = false) => {
      const button = iconButton(name, label, cls);
      button.type = "button";
      button.disabled = disabled;
      button.addEventListener("click", run);
      button.append(el("span", "mobile-action-label", label));
      links.append(button);
      return button;
    };
    const interrupt = action("square", t("web.agent.interrupt"), () => void send(`/interrupt ${agent.id}`, interrupt), "danger", agent.status !== "busy");
    const compact = action("fold", t("web.agent.compact"), () => void send(`/compact ${agent.id}`, compact), "", agent.status === "stopped");
    interrupt.dataset.command = `/interrupt ${agent.id}`;
    compact.dataset.command = `/compact ${agent.id}`;
    const settingsButton = roleButton(agent.id);
    settingsButton.append(el("span", "mobile-action-label", t("web.top.settings")));
    links.append(settingsButton);
    wrap.append(links);
    controlUpdaters.set(wrap, (current) => {
      updateChips(current);
      currentStatus.className = `state mobile-only ${current.status === "busy" ? "working" : current.status}`;
      currentStatus.textContent = t(STATUS_LABEL[current.status]);
      gaugeValues(current.usage).forEach((g, index) => {
        const node = gauges[index];
        if (node) syncGauge(node, g.label, g.value, g.percent, g.over, g.tick, g.reset);
      });
      interrupt.disabled = current.status !== "busy";
      compact.disabled = current.status === "stopped";
    });
    return wrap;
  };

  const stateLabel = (agent: AgentState) => {
    const node = el("span", `state ${agent.status === "busy" ? "working" : agent.status}`, t(STATUS_LABEL[agent.status]));
    return node;
  };
  const roleButton = (id: AgentId) => {
    const button = iconButton("sliders", t("web.role.open", { agent: AGENTS[id].name }), "role-button");
    button.type = "button";
    button.setAttribute("aria-label", t("web.role.open", { agent: AGENTS[id].name }));
    button.title = t("web.role.open", { agent: AGENTS[id].name });
    button.addEventListener("click", () => openAgentSettings(id));
    return button;
  };

  let usageAgent: AgentId | undefined;
  const usagePopover = $("#usage-popover");
  const closeUsage = () => {
    usageAgent = undefined;
    usagePopover.hidden = true;
    for (const button of document.querySelectorAll("#agents button.mini-gauges")) button.setAttribute("aria-expanded", "false");
  };
  const positionUsage = () => {
    if (!usageAgent || usagePopover.hidden) return;
    const card = document.querySelector<HTMLElement>(`#agents [data-agent="${usageAgent}"]`);
    if (!card || mobile.matches || wideUsage.matches) return closeUsage();
    const rect = card.getBoundingClientRect();
    usagePopover.style.left = `${rect.left}px`;
    usagePopover.style.top = `${rect.bottom + USAGE_POPOVER_GAP_PX}px`;
    usagePopover.style.width = `${rect.width}px`;
  };
  const syncUsageDetails = (container: HTMLElement, agent: AgentState) => {
    if (container.dataset.agent !== agent.id) {
      container.replaceChildren(...gaugeValues(agent.usage).map((g) => gauge(g.label, g.value, g.percent, agent.id, g.over, g.tick, g.reset)));
      container.dataset.agent = agent.id;
    }
    gaugeValues(agent.usage).forEach((g, index) => {
      const node = container.children[index] as HTMLElement;
      const value = g.label === t("web.gauge.context") && agent.usage.contextWindow && agent.usage.contextTokens !== undefined
        ? `${g.value} · ${Math.round(g.percent ?? 0)}%` : g.value;
      syncGauge(node, g.label, value, g.percent, g.over, g.tick, g.reset);
      node.querySelector<HTMLElement>(".k")!.textContent = g.label.split(" · ")[0]!;
      node.querySelector<HTMLElement>(".track")!.hidden = g.value === "—";
      node.querySelector<HTMLElement>(".gauge-reset")!.hidden = g.value === "—";
    });
  };
  const refreshUsageSide = () => {
    const side = $("#usage-side");
    if (!wideUsage.matches) return;
    for (const id of AGENT_IDS) {
      const agent = state?.agents.find((entry) => entry.id === id);
      let section = side.querySelector<HTMLElement>(`section[data-agent="${id}"]`);
      if (!agent) { section?.remove(); continue; }
      if (!section) {
        section = el("section");
        section.dataset.agent = id;
        const heading = el("h2");
        heading.append(mark(id), el("span", "", AGENTS[id].name));
        section.append(heading, el("div", "usage-details"));
        side.append(section);
      }
      syncUsageDetails(section.querySelector<HTMLElement>(".usage-details")!, agent);
    }
  };
  const refreshUsage = () => {
    refreshUsageSide();
    if (wideUsage.matches) return closeUsage();
    if (!usageAgent) return;
    const agent = state?.agents.find((entry) => entry.id === usageAgent);
    if (!agent || mobile.matches) return closeUsage();
    syncUsageDetails(usagePopover, agent);
    usagePopover.hidden = false;
    for (const button of document.querySelectorAll("#agents button.mini-gauges")) button.setAttribute("aria-expanded", String(button.closest<HTMLElement>(".agent")?.dataset.agent === agent.id));
    positionUsage();
  };
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && !target.closest("#usage-popover, #agents button.mini-gauges")) closeUsage();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeUsage(); });
  window.addEventListener("resize", positionUsage);
  mobile.addEventListener("change", positionUsage);

  const renderState = () => {
    renderQuestionCount();
    if (!state) return;
    $("#project-name").textContent = state.project.split(/[\\/]/).filter(Boolean).at(-1) || t("web.top.noProject");
    $("#project-pill").title = state.project || t("web.top.noProject");
    // solo で送り先が固定されていればその Agent にする（DESIGN.md §11 Solo）。送り先の色より先に決める
    const solo = state.conversations.find((conversation) => conversation.current)?.solo;
    if (solo && solo !== "free") target = solo;
    document.body.dataset.to = target ?? state.primary;
    const projects = $("#projects") as HTMLSelectElement;
    const selectedProject = state.projects?.find((project) => project.current)?.projectRoot ?? "";
    const listedProjects = state.projects ?? [];
    const projectPaths = listedProjects.map((project) => project.projectRoot);
    if (projects.dataset.paths !== JSON.stringify(projectPaths)) {
      projects.replaceChildren(...listedProjects.map((project) => {
        const option = el("option") as HTMLOptionElement;
        option.value = project.projectRoot;
        option.textContent = project.projectRoot;
        return option;
      }));
      projects.dataset.paths = JSON.stringify(projectPaths);
    }
    projects.hidden = listedProjects.length === 0;
    projects.value = selectedProject;
    // スマホ: 状態の行
    $("#mobile-title").textContent = state.conversations.find((conversation) => conversation.current)?.title ?? t("web.conv.untitled");
    $("#mobile-project").replaceChildren(icon("folder"), el("span", "", $("#project-name").textContent ?? ""));
    $("#mobile-agents").replaceChildren(...state.agents.map((agent) => {
      const button = el("button", "apill") as HTMLButtonElement;
      button.type = "button";
      button.dataset.agent = agent.id;
      button.dataset.state = agent.status;
      button.setAttribute("aria-expanded", String(!sheet.hidden && sheetAgent === agent.id));
      button.setAttribute("aria-label", `${AGENTS[agent.id].name} · ${t(STATUS_LABEL[agent.status])}`);
      button.title = button.getAttribute("aria-label")!;
      const inside = el("span", "in");
      inside.append(el("span", "dot"));
      if (agent.permission === "full") { const shield = icon("shield-alert"); shield.classList.add("shield"); inside.append(shield); }
      const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      ring.setAttribute("viewBox", "0 0 24 24");
      ring.setAttribute("class", "ring");
      ring.setAttribute("aria-hidden", "true");
      const percent = agent.usage.contextWindow ? Math.min(PERCENT, Math.max(0, (agent.usage.contextTokens ?? 0) / agent.usage.contextWindow * PERCENT)) : 0;
      for (const cls of ["bg", "fg"]) {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        for (const [key, value] of Object.entries({ cx: "12", cy: "12", r: "9", class: cls, pathLength: "100" })) circle.setAttribute(key, value);
        if (cls === "fg") circle.setAttribute("stroke-dasharray", `${percent} 100`);
        ring.append(circle);
      }
      inside.append(ring);
      button.append(inside);
      button.addEventListener("click", () => openAgentSheet(agent.id));
      return button;
    }));
    const selected = target ?? state.primary;
    $("#target-toggle").replaceChildren(isShellInput(input.value) ? icon("terminal") : mark(selected));
    $("#target-toggle").setAttribute("aria-label", isShellInput(input.value) ? t("web.shellInput") : `${t("web.to.label")}: ${AGENTS[selected].name}`);
    $("#target-toggle").title = $("#target-toggle").getAttribute("aria-label")!;
    // PC: Agent パネル
    const well = el("div", "strip-well");
    well.append(...state.agents.map((agent) => {
      const section = el("section", `agent ${agent.status}`);
      section.dataset.agent = agent.id;
      const who = el("div", "strip-who");
      const h2 = el("h2");
      const status = stateLabel(agent);
      const turn = items.findLast((item) => item.kind === "turn" && item.agent === agent.id && item.status === "working");
      if (agent.status === "busy" && turn && "at" in turn) {
        const elapsed = el("span", "elapsed", elapsedText(turn.at));
        elapsed.dataset.start = turn.at;
        status.append(elapsed);
      }
      h2.append(el("span", "", AGENTS[agent.id].name), status);
      const current = displayedAgent(agent);
      const summary = el("div", "strip-summary");
      summary.title = t("web.agent.summary", { model: current.modelLabel ?? current.model ?? "default", effort: current.effort ?? "default", permission: current.permission });
      summary.setAttribute("aria-label", summary.title);
      summary.append(el("span", "model", current.modelLabel ?? current.model ?? "default"),
        el("span", "", `· ${current.effort ?? "default"} ·`), el("span", current.permission === "full" ? "permission-full" : "", current.permission));
      if (Object.keys(pendingSettings[agent.id] ?? {}).length) {
        summary.classList.add("pending");
        summary.title += ` · ${t("web.setting.pending")}`;
      }
      who.append(h2, summary);
      const controls = agentControls(agent);
      const miniButton = el(wideUsage.matches ? "div" : "button", "mini-gauges");
      if (miniButton instanceof HTMLButtonElement) {
        miniButton.type = "button";
        miniButton.title = t("web.usage.title");
        miniButton.setAttribute("aria-label", t("web.usage.title"));
        miniButton.setAttribute("aria-expanded", String(usageAgent === agent.id));
        miniButton.setAttribute("aria-controls", "usage-popover");
        miniButton.addEventListener("click", () => {
          if (wideUsage.matches) return;
          if (usageAgent === agent.id) closeUsage();
          else { usageAgent = agent.id; refreshUsage(); }
        });
      }
      miniButton.append(...controls.querySelector(".mini-gauges")!.childNodes);
      section.append(mark(agent.id), who, miniButton, controls.querySelector(".links")!);
      return section;
    }));
    $("#agents").replaceChildren(well);
    refreshUsage();
    $("#conversations").replaceChildren(...conversationList());
    // 送り先: 人が選んでいなければ primary に合わせる
    for (const button of document.querySelectorAll<HTMLButtonElement>(".to button")) {
      const id = button.dataset.agent as AgentId;
      button.setAttribute("aria-pressed", String((target ?? state.primary) === id));
    }
    const soloBadge = $("#solo-badge");
    soloBadge.hidden = !solo;
    soloBadge.textContent = !solo || solo === "free" ? t("shell.solo") : t("shell.soloAgent", { agent: AGENTS[solo].name });
    syncTargetButtons();
    renderPending();
    refreshOpenSheet();
    syncPendingButtons();
  };

  wideUsage.addEventListener("change", () => { closeUsage(); renderState(); });

  // ---- 送信待ちの入力（取り消し・編集。DESIGN.md §28 v0.3 A） ----
  const renderPending = () => {
    const list = $("#pending");
    const pending = state?.pendingInputs ?? [];
    list.hidden = !pending.length;
    list.replaceChildren(...pending.map((queued) => {
      const original = queued.text.split(REFERENCES_SEPARATOR)[0] ?? queued.text;
      const row = el("li");
      const action = (label: string, run: (button: HTMLButtonElement) => void) => {
        const button = el("button", "", label) as HTMLButtonElement;
        button.type = "button";
        button.addEventListener("click", () => run(button));
        button.dataset.command = `/cancel ${queued.id}`;
        return button;
      };
      row.append(
        el("span", "who", t("web.pending.to", { agent: AGENTS[queued.agent].name })),
        el("span", "text", original),
        action(t("web.pending.edit"), (button) => void send(`/cancel ${queued.id}`, button).then((sent) => {
          if (!sent) return;
          target = queued.agent;
          input.value = original;
          input.focus();
          onInputChanged();
          renderState();
        })),
        action(t("web.pending.cancel"), (button) => void send(`/cancel ${queued.id}`, button)),
      );
      return row;
    }));
  };

  const conversationList = () => {
    if (!state) return [];
    const nodes: HTMLElement[] = state.conversations.map((conversation, index) => {
      const row = el("div", `conv-row${conversation.current ? " current" : ""}${conversation.activity === "busy" ? " busy" : ""}`);
      if (conversation.current) {
        const active = state!.agents.filter((agent) => agent.status === "busy");
        const color = active.length > 1 ? state!.primary : active[0]?.id;
        if (color) row.dataset.agent = color;
      }
      const button = el("button", `conv${conversation.current ? " current" : ""}`) as HTMLButtonElement;
      button.type = "button";
      const activity = conversation.activity ? `${t(STATUS_LABEL[conversation.activity])} · ` : "";
      const branch = conversation.branch ? ` · ⎇ ${conversation.branch}` : "";
      const meta = `${conversation.pinned ? t("web.conv.pinned") : ""}${activity}${shortDate(conversation.updatedAt)} · ${Object.keys(conversation.sessions).join(", ") || "—"}${branch}${conversation.current ? t("web.conv.current") : ""}`;
      button.append(el("span", "t", conversation.title ?? t("web.conv.untitled")), el("span", "m", meta));
      button.disabled = conversation.current;
      button.dataset.command = `/resume ${index + 1}`;
      button.addEventListener("click", () => {
        void send(`/resume ${index + 1}`, button).then((ok) => { if (ok) closeSheet(); });
      });
      const menu = iconButton("ellipsis", t("web.conv.menu"), "conv-menu");
      menu.type = "button";
      menu.setAttribute("aria-label", t("web.conv.menu"));
      menu.addEventListener("click", () => openConversationMenu(conversation, index + 1));
      row.append(button, menu);
      return row;
    });
    if (!nodes.length) nodes.push(el("p", "muted small", t("web.conv.empty")));
    return nodes;
  };

  // ---- シート（スマホの操作パネル・会話・設定） ----
  let sheetAgent: AgentId | undefined;
  let sheetKind: "agent" | "agentSettings" | "settings" | "conversations" | "conversationMenu" | "artifacts" | "viewer" | undefined;
  let pendingPrimary: AgentId | undefined;
  const sheet = $("#sheet");
  let sheetReturnFocus: HTMLElement | undefined;
  const openSheet = (title: string, content: HTMLElement[]) => {
    if (sheet.hidden && document.activeElement instanceof HTMLElement) sheetReturnFocus = document.activeElement;
    sheet.classList.remove("mobile-pop", "add-pop");
    $("#sheet-title").textContent = title;
    $("#sheet-body").replaceChildren(...content);
    // ファイルの表示は PC では広く使う
    sheet.querySelector(".sheet-panel")?.classList.toggle("wide", sheetKind === "viewer");
    sheet.classList.toggle("drawer", sheetKind === "conversations" && mobile.matches);
    sheet.hidden = false;
    $("#sheet-close").focus({ preventScroll: true });
    for (const pill of document.querySelectorAll(".apill")) pill.setAttribute("aria-expanded", String((pill as HTMLElement).dataset.agent === sheetAgent));
  };
  const closeSheet = () => {
    sheet.hidden = true;
    sheet.classList.remove("drawer", "mobile-pop", "add-pop");
    if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus({ preventScroll: true });
    sheetReturnFocus = undefined;
    for (const pill of document.querySelectorAll(".apill")) pill.setAttribute("aria-expanded", "false");
    sheetAgent = undefined;
    sheetKind = undefined;
  };
  const openAgentSheet = (id: AgentId) => {
    const agent = state?.agents.find((a) => a.id === id);
    if (!agent) return;
    sheetAgent = id;
    sheetKind = "agent";
    openSheet(AGENTS[id].name, [agentControls(agent)]);
  };
  const openConversations = () => {
    sheetKind = "conversations";
    sheetAgent = undefined;
    const fresh = el("button", "drawer-new", t("web.side.newConversation")) as HTMLButtonElement;
    fresh.type = "button";
    fresh.prepend(icon("square-pen"));
    fresh.addEventListener("click", () => {
      void send("/new", fresh).then((ok) => { if (ok) closeSheet(); });
    });
    const conversations = el("div", "drawer-conversations");
    conversations.append(...conversationList());
    const footer = el("div", "drawer-projects");
    const projects = el("select") as HTMLSelectElement;
    projects.setAttribute("aria-label", t("web.top.projects"));
    for (const project of state?.projects ?? []) {
      const option = el("option") as HTMLOptionElement;
      option.value = project.projectRoot;
      option.textContent = project.projectRoot;
      option.selected = project.current;
      projects.append(option);
    }
    projects.addEventListener("change", () => {
      projects.disabled = true;
      void send(`/project ${projects.value}`).then((ok) => { if (ok) closeSheet(); }).finally(() => { projects.disabled = false; });
    });
    const pill = el("div", "project-pill");
    const selectedName = el("span", "", state?.project.split(/[\\/]/).filter(Boolean).at(-1) ?? t("web.top.noProject"));
    pill.append(icon("folder"), selectedName, icon("chevron-down"), projects);
    footer.append(pill);
    openSheet(t("web.conv.title"), [fresh, conversations, footer]);
  };
  const sheetButton = (label: string, cls: string, run: (button: HTMLButtonElement) => void) => {
    const button = el("button", cls, label) as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", () => run(button));
    return button;
  };
  // ---- 成果物（DESIGN.md §28 v0.3 B） ----
  const fileUrl = (api: "file" | "diff", path: string) => `/api/${api}?path=${encodeURIComponent(path)}`;
  const openArtifacts = () => {
    sheetKind = "artifacts";
    sheetAgent = undefined;
    const artifacts = collectArtifacts(items);
    const rows: HTMLElement[] = artifacts.map((artifact) => {
      const row = el("button", "artifact") as HTMLButtonElement;
      row.type = "button";
      row.append(el("span", `kind ${artifact.kind}`, t(ARTIFACT_LABEL[artifact.kind])),
        el("span", "path mono", displayPath(artifact.path, state?.project ?? "")));
      row.addEventListener("click", () => void openViewer(artifact.path));
      return row;
    });
    openSheet(t("web.artifacts.title"), rows.length ? rows : [el("p", "muted small", t("web.artifacts.empty"))]);
  };
  const openViewer = async (path: string) => {
    sheetKind = "viewer";
    sheetAgent = undefined;
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(path);
    const view = el("div", "viewer");
    const show = async (api: "file" | "diff") => {
      if (isImage) {
        const image = el("img") as HTMLImageElement;
        image.src = fileUrl("file", path);
        image.alt = path;
        return view.replaceChildren(image);
      }
      view.replaceChildren(el("p", "muted small", t("web.viewer.loading")));
      try {
        const response = await fetch(fileUrl(api, path));
        const text = await response.text();
        if (!response.ok) return view.replaceChildren(el("p", "muted small", text || t("web.viewer.failedStatus", { status: response.status })));
        if (api === "diff" && !text) return view.replaceChildren(el("p", "muted small", t("web.viewer.noDiff")));
        if (api === "file" && /\.md$/i.test(path)) {
          const doc = el("div", "md");
          doc.innerHTML = renderMarkdown(text);
          return view.replaceChildren(doc);
        }
        const pre = el("pre", api === "diff" ? "code diff" : "code");
        for (const line of text.split("\n")) {
          const cls = api !== "diff" ? "" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
          pre.append(el("span", cls, `${line}\n`));
        }
        view.replaceChildren(pre);
      } catch {
        view.replaceChildren(el("p", "muted small", t("web.viewer.failed")));
      }
    };
    const content: HTMLElement[] = [];
    if (!isImage) {
      content.push(choice("view", t("web.viewer.view"), ["file", "diff"] as const, "file", (v) => t(v === "file" ? "web.viewer.content" : "web.viewer.diff"), (v) => void show(v)));
    }
    content.push(view);
    openSheet(displayPath(path, state?.project ?? ""), content);
    await show("file");
  };

  // 会話の操作: 名前の変更は今の会話だけ（/rename）。今の会話は削除できない
  const openConversationMenu = (conversation: WebState["conversations"][number], number: number) => {
    sheetKind = "conversationMenu";
    sheetAgent = undefined;
    const title = conversation.title ?? t("web.conv.untitled");
    const actions: HTMLElement[] = [];
    if (conversation.current) {
      actions.push(sheetButton(t("web.conv.rename"), "secondary-action", (button) => {
        const name = window.prompt(t("web.conv.renamePrompt"), conversation.title ?? "")?.trim();
        if (name) void send(`/rename ${name}`, button).then((ok) => { if (ok) closeSheet(); });
        else closeSheet();
      }));
    }
    actions.push(sheetButton(t(conversation.pinned ? "web.conv.unpin" : "web.conv.pin"), "secondary-action", (button) => {
      void send(`/pin ${number}`, button).then((ok) => { if (ok) closeSheet(); });
    }));
    if (!conversation.current) {
      actions.push(sheetButton(t("web.conv.delete"), "secondary-action danger", (button) => {
        if (window.confirm(t("web.conv.deleteConfirm", { title }))) void send(`/delete ${number}`, button).then((ok) => { if (ok) closeSheet(); });
        else closeSheet();
      }));
    }
    openSheet(title, actions);
  };

  // Agent の設定: 役割・権限・model・effort と、この Agent だけの session のやり直し
  const openAgentSettings = (id: AgentId) => {
    const incoming = state?.agents.find((a) => a.id === id);
    if (!incoming) return;
    const agent = displayedAgent(incoming);
    sheetAgent = id;
    sheetKind = "agentSettings";
    const roleField = el("textarea", "role-editor") as HTMLTextAreaElement;
    roleField.value = state?.roles[id] ?? "";
    roleField.setAttribute("aria-label", t("web.role.title", { agent: AGENTS[id].name }));
    const saveRole = sheetButton(t("web.role.save"), "primary-action", () => {
      const value = roleField.value.replace(/\s+/g, " ").trim();
      if (!value) return;
      void send(`/role ${id} ${value}`, saveRole).then((ok) => { if (ok) closeSheet(); });
    });
    const permission = choice("permission", t("web.agentSettings.permission"), PERMISSIONS, agent.permission, (v) => v, (v) => void requestSetting(id, "permission", v));
    const model = el("div", "setting");
    model.append(el("div", "eyebrow", t("web.agentSettings.model")));
    const form = el("form", "model-form") as HTMLFormElement;
    const select = el("select") as HTMLSelectElement;
    select.name = "model-choice";
    select.setAttribute("aria-label", t("web.agentSettings.modelLabel", { agent: AGENTS[id].name }));
    const models = agent.models;
    for (const item of models) {
      const option = el("option", "", item.label) as HTMLOptionElement;
      option.value = item.value;
      select.append(option);
    }
    const other = el("option", "", t("web.model.other")) as HTMLOptionElement;
    other.value = "__other__";
    select.append(other);
    const selectedModel = models.find((item) => item.value === agent.model)
      ?? models.find((item) => item.resolved === agent.model && item.value !== "default")
      ?? models.find((item) => item.resolved === agent.model);
    select.value = selectedModel?.value ?? "__other__";
    const field = el("input") as HTMLInputElement;
    field.name = "model";
    field.autocomplete = "off";
    field.placeholder = agent.modelLabel ?? agent.model ?? "default";
    field.setAttribute("aria-label", t("web.agentSettings.modelLabel", { agent: AGENTS[id].name }));
    field.hidden = select.value !== "__other__";
    select.addEventListener("change", () => { field.hidden = select.value !== "__other__"; if (!field.hidden) field.focus(); });
    const apply = el("button", "", t("web.agentSettings.apply")) as HTMLButtonElement;
    apply.type = "submit";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = select.value === "__other__" ? field.value.trim() : select.value;
      if (!value) return;
      void requestSetting(id, "model", value, apply).then((sent) => { if (sent && field.value.trim() === value) field.value = ""; });
    });
    form.append(select, field, apply);
    model.append(form);
    const effort = choice("effort", t("web.agentSettings.effort"), EFFORTS[id], agent.effort ?? "", (v) => v, (v) => void requestSetting(id, "effort", v));
    const restart = sheetButton(t("web.agentSettings.restart"), "secondary-action", () => {
      void send(`/new ${id}`, restart).then((ok) => { if (ok) closeSheet(); });
    });
    openSheet(t("web.agentSettings.title", { agent: AGENTS[id].name }), [
      el("div", "eyebrow", t("web.role.title", { agent: AGENTS[id].name })),
      roleField, saveRole, el("p", "muted small", t("web.role.restart", { agent: id })),
      permission, model, effort, el("div", "setting-pending"), restart,
    ]);
    refreshOpenSheet();
  };

  const choice = <T extends string>(key: string, label: string, options: readonly T[], current: T, name: (v: T) => string, pick: (v: T, button: HTMLButtonElement) => void) => {
    const wrap = el("div", "setting");
    wrap.append(el("div", "eyebrow", label));
    const seg = el("div", "seg");
    seg.dataset.choice = key;
    for (const option of options) {
      const button = el("button", "", name(option)) as HTMLButtonElement;
      button.type = "button";
      button.dataset.value = option;
      button.setAttribute("aria-pressed", String(option === current));
      button.addEventListener("click", () => {
        pick(option, button);
        for (const selected of seg.querySelectorAll<HTMLButtonElement>("button")) {
          selected.setAttribute("aria-pressed", String(selected === button));
        }
      });
      seg.append(button);
    }
    wrap.append(seg);
    return wrap;
  };
  const LIMIT_LABEL: Record<keyof WebState["limits"], MessageKey> = {
    messages: "web.settings.messages", reviews: "web.settings.reviews", delegations: "web.settings.delegations", depth: "web.settings.depth",
  };
  const LIMIT_MIN = 1;
  const LIMIT_MAX = 100;
  const settingsRequests = new Set<string>();
  const settingsChoice = <T extends string>(key: string, label: string, options: readonly T[], current: T, name: (value: T) => string) =>
    choice(key, label, options, current, name, (value, button) => {
      const segment = button.parentElement!;
      settingsRequests.add(key);
      for (const control of segment.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true;
      void send(`/${key} ${value}`, button).then(() => {
        settingsRequests.delete(key);
        for (const control of document.querySelectorAll<HTMLButtonElement>(`[data-choice="${key}"] button`)) { setPending(control, false); control.disabled = false; }
        refreshOpenSheet();
      });
    });
  const openSettings = () => {
    if (!state) return;
    sheetKind = "settings";
    sheetAgent = undefined;
    const sandbox = settingsChoice("sandbox", t("web.settings.sandbox"), ["off", "on"] as const, state.sandbox.enabled ? "on" : "off", value => value);
    sandbox.append(el("p", "muted small sandbox-ready"));
    const limits = el("section", "setting limits-settings");
    limits.append(el("div", "eyebrow", t("web.settings.limits")));
    for (const name of Object.keys(LIMIT_LABEL) as Array<keyof WebState["limits"]>) {
      const row = el("form", "limit-row") as HTMLFormElement;
      row.dataset.limit = name;
      const label = el("label", "limit-label", t(LIMIT_LABEL[name])) as HTMLLabelElement;
      label.htmlFor = `limit-${name}`;
      label.title = name;
      const mark = el("span", "limit-changed", "•");
      mark.title = t("web.settings.changed");
      mark.setAttribute("aria-label", mark.title);
      label.append(mark);
      const field = el("input") as HTMLInputElement;
      field.id = label.htmlFor;
      field.name = name;
      field.type = "number";
      field.min = String(LIMIT_MIN);
      field.max = String(LIMIT_MAX);
      field.step = "1";
      field.required = true;
      const button = el("button", "btn", t("web.settings.apply")) as HTMLButtonElement;
      button.type = "submit";
      row.append(label, field, button, el("span", "muted small limit-default"));
      row.addEventListener("submit", event => {
        event.preventDefault();
        if (!row.reportValidity() || settingsRequests.has(name)) return;
        settingsRequests.add(name);
        field.disabled = true;
        void send(`/limits ${name} ${field.value}`, button).finally(() => {
          settingsRequests.delete(name);
          const activeField = document.querySelector<HTMLInputElement>(`#limit-${name}`);
          if (activeField) activeField.disabled = false;
          refreshOpenSheet();
        });
      });
      limits.append(row);
    }
    const reset = el("button", "btn limits-reset", t("web.settings.reset")) as HTMLButtonElement;
    reset.type = "button";
    reset.addEventListener("click", () => void send("/limits reset", reset));
    const unlimited = el("button", "btn limits-unlimited", t("web.settings.unlimited")) as HTMLButtonElement;
    unlimited.type = "button";
    unlimited.addEventListener("click", () => void send("/limits unlimited", unlimited));
    const actions = el("div", "limits-actions");
    actions.append(reset, unlimited);
    limits.append(actions);
    const language = settingsChoice("language", t("web.settings.language"), ["ja", "en"] as const, state.language, value => value === "ja" ? "日本語" : "English");
    // 端末ごとの設定なので Hub には送らない。スマホは常に Enter で改行するので出さない
    const sendKeyChoice = choice("sendKey", t("web.settings.sendKey"), SEND_KEYS, sendKey,
      value => t(value === "enter" ? "web.settings.sendEnter" : "web.settings.sendCtrlEnter"),
      value => { sendKey = value; storage.set(SEND_KEY_KEY, value); });
    openSheet(t("web.settings.title"), mobile.matches ? [sandbox, limits, language] : [sandbox, limits, language, sendKeyChoice]);
    refreshOpenSheet();
  };

  const refreshOpenSheet = () => {
    if (sheet.hidden) return;
    if (sheetKind === "agent" && sheetAgent) {
      const agent = state?.agents.find((candidate) => candidate.id === sheetAgent);
      const controls = $("#sheet-body").querySelector<HTMLElement>(".controls");
      if (agent && controls) controlUpdaters.get(controls)?.(agent);
    }
    if (sheetKind === "agentSettings" && sheetAgent) {
      const incoming = state?.agents.find((candidate) => candidate.id === sheetAgent);
      if (!incoming) return;
      const agent = displayedAgent(incoming);
      const waiting = pendingSettings[sheetAgent];
      const body = $("#sheet-body");
      const press = (key: string, value: string | undefined) => {
        for (const button of body.querySelectorAll<HTMLButtonElement>(`[data-choice="${key}"] button`)) {
          button.setAttribute("aria-pressed", String(button.dataset.value === value));
          const pending = waiting?.[key as "permission" | "effort"] !== undefined;
          button.disabled = pending;
          setPending(button, pending && button.dataset.value === value);
          if (!pending) button.disabled = false;
        }
      };
      press("permission", agent.permission);
      press("effort", agent.effort);
      const select = body.querySelector<HTMLSelectElement>('select[name="model-choice"]');
      const field = body.querySelector<HTMLInputElement>('input[name="model"]');
      if (select) {
        const listed = [...select.options].filter((option) => option.value !== "__other__").map((option) => option.value);
        const incoming = agent.models.map((item) => item.value);
        if (listed.join("\u0000") !== incoming.join("\u0000")) {
          const previous = select.value;
          select.replaceChildren();
          for (const item of agent.models) {
            const option = el("option", "", item.label) as HTMLOptionElement;
            option.value = item.value;
            select.append(option);
          }
          const other = el("option", "", t("web.model.other")) as HTMLOptionElement;
          other.value = "__other__";
          select.append(other);
          const resolved = agent.models.find((item) => item.value === agent.model)
            ?? agent.models.find((item) => item.resolved === agent.model && item.value !== "default")
            ?? agent.models.find((item) => item.resolved === agent.model);
          select.value = previous === "__other__" && field?.value ? "__other__" : resolved?.value ?? "__other__";
          if (field) field.hidden = select.value !== "__other__";
        }
      }
      if (field) field.placeholder = agent.modelLabel ?? agent.model ?? "default";
      const apply = body.querySelector<HTMLButtonElement>(".model-form button");
      if (apply) { setPending(apply, waiting?.model !== undefined); apply.disabled = waiting?.model !== undefined; }
      if (select) select.disabled = waiting?.model !== undefined;
      if (field) field.disabled = waiting?.model !== undefined;
      const pendingLabel = body.querySelector<HTMLElement>(".setting-pending");
      if (pendingLabel) {
        pendingLabel.hidden = !waiting || !Object.keys(waiting).length;
        pendingLabel.replaceChildren(el("span", "spin"), el("span", "", t("web.setting.pending")));
      }
    }
    if (sheetKind === "settings" && state) {
      const body = $("#sheet-body");
      for (const [key, value] of [["sandbox", state.sandbox.enabled ? "on" : "off"], ["language", state.language]]) {
        const pendingLine = [...pendingRequests].find(line => line.startsWith(`/${key} `));
        for (const button of body.querySelectorAll<HTMLButtonElement>(`[data-choice="${key}"] button`)) {
          button.setAttribute("aria-pressed", String(button.dataset.value === (pendingLine?.split(" ")[1] ?? value)));
          setPending(button, Boolean(pendingLine) && button.dataset.value === pendingLine?.split(" ")[1]);
          button.disabled = Boolean(pendingLine);
        }
      }
      const ready = body.querySelector<HTMLElement>(".sandbox-ready");
      if (ready) ready.textContent = t(state.sandbox.ready ? "web.settings.ready" : "web.settings.notReady");
      body.querySelector(".limits-settings")?.classList.toggle("unlimited", state.limitsUnlimited);
      body.querySelector(".limits-unlimited")?.setAttribute("aria-pressed", String(state.limitsUnlimited));
      for (const row of body.querySelectorAll<HTMLElement>("[data-limit]")) {
        const name = row.dataset.limit as keyof WebState["limits"];
        const limit = state.limits[name];
        const field = row.querySelector<HTMLInputElement>("input")!;
        field.disabled = settingsRequests.has(name);
        if (field.dataset.synced !== String(limit.value)) {
          field.value = String(limit.value);
          field.dataset.synced = field.value;
        }
        row.querySelector<HTMLElement>(".limit-default")!.textContent = t("web.settings.default", { value: limit.default });
        row.querySelector<HTMLElement>(".limit-changed")!.hidden = limit.value === limit.default;
      }
    }
  };

  $("#mobile-menu").addEventListener("click", openConversations);
  $("#target-toggle").addEventListener("click", () => {
    target = (target ?? state?.primary ?? "claude") === "claude" ? "codex" : "claude";
    renderState();
  });
  $("#mobile-more").addEventListener("click", () => {
    sheetKind = undefined;
    sheetAgent = undefined;
    const actions = el("div", "mobile-menu-actions");
    for (const [name, key, id] of [["files", "web.top.artifacts", "open-artifacts"], ["settings", "web.top.settings", "open-settings"], ["list-tree", "web.mobile.detail", "detail"], ["folder-open", "web.mobile.openProject", "open-project"]] as const) {
      const button = iconButton(name, t(key));
      button.append(el("span", "", t(key)));
      if (id === "detail") button.setAttribute("aria-pressed", String(detail));
      button.addEventListener("click", () => { closeSheet(); $("#" + id).click(); });
      actions.append(button);
    }
    const themeButton = iconButton(THEME_ICON[theme], "");
    themeButton.id = "mobile-theme";
    syncThemeButton(themeButton, true);
    themeButton.addEventListener("click", cycleTheme);
    actions.insertBefore(themeButton, actions.children[1]!);
    const project = iconButton("folder", t("web.mobile.project"));
    project.append(el("span", "", `${t("web.mobile.project")}: ${$("#project-name").textContent}`));
    project.addEventListener("click", openConversations);
    actions.insertBefore(project, actions.lastElementChild);
    openSheet(t("web.top.more"), [actions]);
    sheet.classList.add("mobile-pop");
    actions.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  });
  $("#mobile-add").addEventListener("click", () => {
    sheetKind = undefined;
    sheetAgent = undefined;
    const actions = el("div", "mobile-menu-actions");
    for (const [name, key] of [["image-plus", "web.mobile.image"], ["terminal", "web.mobile.command"]] as const) {
      const button = iconButton(name, t(key));
      button.append(el("span", "", t(key)));
      button.addEventListener("click", () => {
        closeSheet();
        if (name === "image-plus") $("#attach-file").click();
        else { if (!input.value.startsWith("!")) input.value = "!" + input.value; onInputChanged(); input.focus(); }
      });
      actions.append(button);
    }
    openSheet(t("web.mobile.add"), [actions]);
    sheet.classList.add("mobile-pop", "add-pop");
    actions.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  });
  const tabs = $(".working-tabs");
  const tabHome = tabs.parentElement!;
  const adaptTabs = () => {
    (mobile.matches ? $("#composer") : tabHome).prepend(tabs);
    for (const [id, key] of [["working-toggle", "web.working.title"], ["question-toggle", "web.question.title"]] as const) {
      const button = $("#" + id);
      button.querySelector(".mobile-tab-label")?.remove();
      if (mobile.matches) button.querySelector(".i")?.after(el("span", "mobile-tab-label", t(key)));
    }
  };
  mobile.addEventListener("change", adaptTabs);
  adaptTabs();
  const grab = $("#sheet-grab");
  let dragStart: number | undefined;
  grab.addEventListener("pointerdown", (event) => {
    dragStart = event.clientY;
    grab.setPointerCapture(event.pointerId);
  });
  grab.addEventListener("pointerup", (event) => {
    if (dragStart !== undefined && event.clientY - dragStart >= SWIPE_CLOSE_PX) closeSheet();
    dragStart = undefined;
  });
  grab.addEventListener("pointercancel", () => { dragStart = undefined; });
  const syncViewport = () => {
    const viewport = window.visualViewport;
    const focused = document.activeElement?.matches("input, textarea, select");
    const keyboard = mobile.matches && focused && viewport && viewport.scale === 1 && window.innerHeight - viewport.height > KEYBOARD_THRESHOLD_PX;
    document.body.classList.toggle("kbd", Boolean(keyboard));
    const root = document.documentElement.style;
    if (mobile.matches && viewport?.scale === 1) {
      // iOS はキーボードを出すとページを offsetTop だけスクロールするので、固定した .app を見えている領域に合わせる
      root.setProperty("--viewport-height", `${viewport.height}px`);
      root.setProperty("--viewport-top", `${viewport.offsetTop}px`);
    } else {
      root.removeProperty("--viewport-height");
      root.removeProperty("--viewport-top");
    }
  };
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
  window.addEventListener("resize", syncViewport);
  document.addEventListener("focusin", syncViewport);
  document.addEventListener("focusout", () => requestAnimationFrame(syncViewport));
  syncViewport();
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-backdrop").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (sheet.hidden) return;
    if (e.key === "Escape") closeSheet();
    if (e.key !== "Tab") return;
    const controls = [...sheet.querySelectorAll<HTMLElement>('.sheet-panel button:not(:disabled), .sheet-panel input:not(:disabled), .sheet-panel select:not(:disabled), .sheet-panel textarea:not(:disabled), .sheet-panel [tabindex="0"]')].filter((node) => node.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  $("#open-conversations").addEventListener("click", openConversations);
  $("#open-settings").addEventListener("click", openSettings);
  $("#new-conversation").addEventListener("click", () => void send("/new", $("#new-conversation")));
  $("#open-artifacts").addEventListener("click", openArtifacts);
  $("#projects").addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!value) return;
    const select = event.currentTarget as HTMLSelectElement;
    select.disabled = true;
    $("#project-pill").classList.add("is-loading");
    void send(`/project ${value}`).then((ok) => { if (!ok) renderState(); }).finally(() => {
      select.disabled = false;
      $("#project-pill").classList.remove("is-loading");
    });
  });
  $("#open-project").addEventListener("click", () => void withPending($("#open-project"), async () => {
    const tauri = (window as Window & { __TAURI__?: { dialog?: { open(options: { directory: boolean; multiple: boolean }): Promise<string | null> } } }).__TAURI__;
    const dialog = tauri?.dialog;
    const path = await chooseProjectPath(
      dialog ? () => dialog.open({ directory: true, multiple: false }) : undefined,
      () => window.prompt(t("web.top.projectPrompt")),
    );
    if (path) await send(`/project ${path}`);
    return undefined;
  }));

  // ---- 詳細表示 ----
  const detailButton = $("#detail");
  const setDetail = (value: boolean) => {
    detail = value;
    storage.set(DETAIL_KEY, value ? "1" : "0");
    opened.clear();
    detailButton.setAttribute("aria-pressed", String(value));
    renderLog(true);
  };
  detailButton.setAttribute("aria-pressed", String(detail));
  detailButton.addEventListener("click", () => setDetail(!detail));

  // ---- 入力 ----
  const coarse = mobile.matches;
  const resize = () => {
    const stick = nearBottom();
    input.style.height = "";
    // 空欄の scrollHeight は折り返したプレースホルダの高さになるため、1 行のままにする
    if (input.value) input.style.height = `${input.scrollHeight}px`;
    input.style.overflowY = input.scrollHeight > input.clientHeight ? "auto" : "hidden";
    if (stick) requestAnimationFrame(scrollToBottom);
  };
  // 送信に成功してから入力欄を空にする（失敗しても書いた内容を失わない）
  const sendButton = $("#composer .send") as HTMLButtonElement;
  const submit = async () => {
    const text = input.value.trim();
    if (!text || sendButton.disabled || uploading > 0) return;
    const to = target ?? state?.primary;
    const sent = await send(composeInputLine(text, to), sendButton);
    sendButton.disabled = uploading > 0;
    if (!sent) return;
    if (input.value.trim() === text) input.value = "";
    onInputChanged();
    scrollToBottom();
  };
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
  // ---- 入力の補助（候補と強調表示。DESIGN.md §28 v0.3 A） ----
  const assist = createInputAssist(commands, AGENT_IDS, {
    agent: t("web.assist.agent"), file: t("web.assist.file"), permission: t("web.assist.permission"),
    effort: t("web.assist.effort"), model: t("web.assist.model"), conversation: t("web.assist.conversation"),
    project: t("web.assist.project"), worktree: t("web.assist.worktree"), queued: t("web.assist.queued"),
  });
  const highlightLayer = $("#input-highlight");
  const suggestList = $("#suggest");
  let files: string[] = [];
  let fileSet = new Set<string>();
  let filesLoadedAt = 0;
  let filesLoading = false;
  let filesGeneration = 0;
  let suggestion: Suggestion | undefined;
  let selected = 0;

  const renderHighlight = () => {
    const nodes: Node[] = assist.highlight(input.value, fileSet).map((segment) => {
      if (!segment.kind) return document.createTextNode(segment.text);
      return el("mark", segment.kind === "agent" ? `hl-${segment.text.slice(1).replace(/!$/, "")}` : `hl-${segment.kind}`, segment.text);
    });
    // 末尾の改行も高さに反映されるよう、幅の無い文字を足す
    highlightLayer.replaceChildren(...nodes, document.createTextNode("\u200b"));
    highlightLayer.scrollTop = input.scrollTop;
  };
  const closeSuggest = () => {
    suggestion = undefined;
    suggestList.hidden = true;
    input.setAttribute("aria-expanded", "false");
  };
  const accept = (index: number) => {
    const item = suggestion?.items[index];
    if (!suggestion || !item) return;
    const { from, to } = suggestion;
    input.value = input.value.slice(0, from) + item.insert + input.value.slice(to).replace(/^ /, "");
    const caret = from + item.insert.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    onInputChanged();
  };
  const renderSuggest = () => {
    const loading = filesLoading && /(?:^|\s)@[^\s]*$/.test(input.value.slice(0, input.selectionStart));
    if (!suggestion && !loading) return closeSuggest();
    suggestList.replaceChildren(...(suggestion?.items ?? []).map((item, index) => {
      const option = el("li");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === selected));
      option.append(el("span", "l", item.label), el("span", "d", item.detail));
      // 入力欄のフォーカスを外さずに選ぶ
      option.addEventListener("pointerdown", (e) => e.preventDefault());
      option.addEventListener("click", () => accept(index));
      return option;
    }));
    if (loading) {
      const row = el("li", "muted", t("web.files.loading"));
      row.prepend(el("span", "spin"));
      row.setAttribute("role", "option");
      row.setAttribute("aria-disabled", "true");
      suggestList.append(row);
    }
    suggestList.hidden = false;
    input.setAttribute("aria-expanded", "true");
    suggestList.children[selected]?.scrollIntoView({ block: "nearest" });
  };
  const updateSuggest = () => {
    const caret = input.selectionStart;
    suggestion = caret === input.selectionEnd ? assist.suggest(input.value, caret, files, state) : undefined;
    selected = 0;
    renderSuggest();
  };
  const loadFiles = async () => {
    if (filesLoading || Date.now() - filesLoadedAt < FILES_REFRESH_MS) return;
    const generation = filesGeneration;
    filesLoading = true;
    updateSuggest();
    try {
      const response = await fetch("/api/files");
      if (!response.ok || generation !== filesGeneration) return;
      const loaded = await response.json() as string[];
      if (generation !== filesGeneration) return;
      files = loaded;
      fileSet = new Set(files);
      renderHighlight();
    } catch { /* 候補が出ないだけで入力はできる */ }
    finally {
      if (generation === filesGeneration) {
        filesLoading = false;
        filesLoadedAt = Date.now();
        if (document.activeElement === input) updateSuggest();
      }
    }
  };
  // コマンド入力中と、solo で送り先が固定されているときは送り先を変えられない
  function syncTargetButtons() {
    const shell = isShellInput(input.value);
    const solo = state?.conversations.find((conversation) => conversation.current)?.solo;
    const disabled = shell || Boolean(solo && solo !== "free");
    for (const button of document.querySelectorAll<HTMLButtonElement>(".to button, #target-toggle")) button.disabled = disabled;
    $("#target-toggle").replaceChildren(shell ? icon("terminal") : mark(target ?? state?.primary ?? "claude"));
    $("#target-toggle").setAttribute("aria-label", shell ? t("web.shellInput") : `${t("web.to.label")}: ${AGENTS[target ?? state?.primary ?? "claude"].name}`);
    $("#target-toggle").title = $("#target-toggle").getAttribute("aria-label")!;
  }
  function onInputChanged() {
    const shell = isShellInput(input.value);
    $("#composer").classList.toggle("shell-input", shell);
    sendButton.replaceChildren(icon(shell ? "terminal" : "arrow-up"));
    sendButton.setAttribute("aria-label", t(shell ? "web.run" : "web.send"));
    sendButton.title = t(shell ? "web.run" : "web.send");
    syncTargetButtons();
    resize();
    renderHighlight();
    updateSuggest();
    if (/(?:^|\s)@/.test(input.value)) void loadFiles();
  }

  // ---- 画像の添付（DESIGN.md §28 v0.3 C）: 保存してから @<パス> を入力欄に足す ----
  const insertAtCaret = (text: string) => {
    const start = input.selectionStart;
    const before = input.value.slice(0, start);
    const spacer = before && !/\s$/.test(before) ? " " : "";
    input.value = `${before}${spacer}${text}${input.value.slice(input.selectionEnd)}`;
    const caret = before.length + spacer.length + text.length;
    input.setSelectionRange(caret, caret);
    onInputChanged();
  };
  const attach = async (file: Blob) => {
    const generation = liveGeneration;
    uploading++;
    $("#upload-status").hidden = false;
    sendButton.disabled = true;
    try {
      const response = await fetch("/api/upload", { method: "POST", headers: { "content-type": file.type }, body: file });
      if (!response.ok) return showToast(t("web.upload.failed"));
      const { path } = (await response.json()) as { path: string };
      if (generation === liveGeneration) insertAtCaret(`@${path} `);
    } catch {
      showToast(t("web.upload.failed"));
    } finally {
      uploading--;
      $("#upload-status").hidden = uploading === 0;
      sendButton.disabled = uploading > 0 || sendButton.classList.contains("is-loading");
    }
  };
  const fileInput = document.querySelector<HTMLInputElement>("#attach-file")!;
  $("#attach").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    for (const file of fileInput.files ?? []) void attach(file);
    fileInput.value = "";
  });
  input.addEventListener("paste", (e) => {
    const images = [...(e.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    for (const image of images) void attach(image);
  });

  input.addEventListener("input", onInputChanged);
  input.addEventListener("focus", () => void loadFiles());
  input.addEventListener("blur", closeSuggest);
  input.addEventListener("scroll", () => { highlightLayer.scrollTop = input.scrollTop; });
  input.addEventListener("click", updateSuggest);
  input.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateSuggest();
  });
  // PC は送信キーの設定で送信。スマホは Enter で改行し、送信はボタン（日本語入力の誤送信を防ぐ）
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (suggestion) {
      const count = suggestion.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        selected = (selected + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
        return renderSuggest();
      }
      // Enter は候補を確定しない（入力のまま送れるように）
      if (e.key === "Tab") {
        e.preventDefault();
        return accept(selected);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return closeSuggest();
      }
    }
    if (!isSendKey(e, sendKey, mobile.matches)) return;
    e.preventDefault();
    void submit();
  });
  input.placeholder = t(coarse ? "web.input.placeholderTouch" : "web.input.placeholder");
  for (const button of document.querySelectorAll<HTMLButtonElement>(".to button")) {
    button.addEventListener("click", () => {
      target = button.dataset.agent as AgentId;
      renderState();
    });
  }

  newer.addEventListener("click", scrollToBottom);
  setInterval(() => {
    for (const node of log.querySelectorAll<HTMLElement>(".elapsed[data-start]")) node.textContent = elapsedText(node.dataset.start ?? "");
    for (const node of document.querySelectorAll<HTMLElement>("#working-panel .elapsed[data-start], #agents .elapsed[data-start]")) node.textContent = elapsedText(node.dataset.start ?? "");
  }, MS_PER_SECOND);
  const loadHistory = async () => {
    const oldest = history[0];
    if (!oldest || historyLoading || !historyHasMore || replaying) return;
    const generation = historyGeneration;
    historyLoading = true;
    $("#history-loading").hidden = false;
    try {
      const response = await fetch(`/api/history?before=${oldest.seq}`);
      if (!response.ok) throw new Error(String(response.status));
      const page = await response.json() as HistoryPage;
      if (generation !== historyGeneration) return;
      historyHasMore = page.hasMore;
      const previousHeight = log.scrollHeight;
      const previousTop = log.scrollTop;
      const wasNewerHidden = newer.hidden;
      history = [...page.items, ...history];
      historyLoading = false;
      const queued = new Set(items.filter((item) => item.kind === "human" && item.queued).map((item) => item.id));
      items = rebuildTimeline(history, applyFeedItem).map((item) => item.kind === "human" && queued.has(item.id) ? { ...item, queued: true } : item);
      renderLog();
      log.scrollTop = previousTop + log.scrollHeight - previousHeight;
      newer.hidden = wasNewerHidden;
    } catch {
      if (generation === historyGeneration) showToast(t("web.history.failed"), "warn");
    } finally {
      if (generation === historyGeneration) { historyLoading = false; $("#history-loading").hidden = true; }
    }
  };
  log.addEventListener("scroll", () => {
    if (nearBottom()) newer.hidden = true;
    if (log.scrollTop <= HISTORY_THRESHOLD_PX) void loadHistory();
  });

  // ---- 接続 ----
  let notificationState: DesktopNotifyState = { live: false, working: false };
  // 指定しないと Tauri の通知は無音になる
  const NOTIFICATION_SOUND = "Default";
  const notify = async (notification: DesktopNotification) => {
    const plugin = (window as Window & { __TAURI__?: { notification?: {
      isPermissionGranted(): Promise<boolean>;
      requestPermission(): Promise<string>;
      sendNotification(notification: DesktopNotification & { sound: string }): void | Promise<void>;
    } } }).__TAURI__?.notification;
    if (!plugin || (!document.hidden && document.hasFocus())) return;
    try {
      const granted = await plugin.isPermissionGranted() || await plugin.requestPermission() === "granted";
      if (granted && (document.hidden || !document.hasFocus())) await plugin.sendNotification({ ...notification, sound: NOTIFICATION_SOUND });
    } catch { /* 通知の失敗で feed の描画を止めない */ }
  };
  const conn = $("#conn");
  const commitReplay = () => {
    if (!replaying) return;
    history = incomingHistory;
    incomingHistory = [];
    items = rebuildTimeline(history, applyFeedItem).map((item) => item.kind === "human" ? { ...item, queued: true } : item);
    opened.clear();
    historyGeneration++;
    historyLoading = false;
    historyHasMore = true;
    commandStarts = {};
    replaying = false;
  };
  const scheduleLog = () => {
    if (replayScheduled) return;
    replayScheduled = true;
    requestAnimationFrame(() => { replayScheduled = false; if (!replaying) renderLog(); });
  };
  $("#reload").addEventListener("click", () => location.reload());
  const connect = () => {
    const events = new EventSource("/events");
    events.onopen = () => {
      notificationState = { live: false, working: false };
      replaying = true;
      historyGeneration++;
      historyLoading = false;
      $("#history-loading").hidden = true;
      incomingHistory = [];
    };
    events.onmessage = (e: MessageEvent<string>) => {
      if (reloading) return;
      const item = JSON.parse(e.data) as FeedItem;
      const update = updateDesktopNotify(notificationState, item, messages);
      notificationState = update.state;
      if (update.notification) void notify(update.notification);
      if (item.type === "version") {
        if (item.version !== version) {
          reloading = true;
          conn.hidden = false;
          $("#conn-label").textContent = t("web.conn.updated");
          $(".app").classList.add("navigation-pending");
          window.setTimeout(() => location.reload(), RELOAD_DELAY_MS);
        }
        return;
      }
      if (item.type === "state") {
        const projectChanged = state?.project !== item.state.project;
        const conversationChanged = state?.conversations.find((entry) => entry.current)?.id !== item.state.conversations.find((entry) => entry.current)?.id;
        if (projectChanged || conversationChanged) {
          liveGeneration++;
          startingAt.clear();
          closeUsage();
          pendingSettings = {};
          pendingDeadlines = {};
          settingRequests.clear();
          interrupting.clear();
          if (projectChanged) {
            files = []; fileSet.clear(); filesLoadedAt = 0; filesLoading = false; filesGeneration++;
            target = undefined; pendingPrimary = undefined;
          }
          closeSheet();
        }
        commitReplay();
        state = item.state;
        pendingSettings = resolvePendingSettings(pendingSettings, state.agents, pendingDeadlines);
        for (const agent of state.agents) if (agent.status !== "busy") interrupting.delete(agent.id);
        if (pendingPrimary && state.primary === pendingPrimary) {
          if (target === pendingPrimary) target = undefined;
          pendingPrimary = undefined;
        }
        $(".app").classList.remove("initial-loading");
        $(".app").setAttribute("aria-busy", "false");
        conn.hidden = true;
        $("#reload").hidden = true;
        $("#conn-spinner").hidden = false;
        renderState();
        renderLog();
        if (projectChanged && document.activeElement === input) void loadFiles();
        return;
      }
      if (item.type === "toast") { showToast(item.text, item.level); return; }
      if (item.type === "reset") {
        incomingHistory = [];
        historyGeneration++;
        historyLoading = false;
        $("#history-loading").hidden = true;
        replaying = true;
        questionDrafts.clear();
        opened.clear();
        return;
      }
      if (replaying) { incomingHistory.push(item); return; }
      history.push(item);
      items = applyFeedItem(items, item);
      if (item.type === "output") commandStarts = nextCommandStarts(commandStarts, item.command, new Date().toISOString(), items.at(-1)?.id);
      if (item.type === "event" && item.event.kind === "human") {
        items = withStartingTurns(items, state?.agents ?? [], item.event.at, state?.pendingInputs ?? []).filter((entry): entry is TimelineItem => entry.kind !== "starting");
      }
      scheduleLog();
    };
    events.onerror = () => {
      if (reloading) return;
      conn.hidden = false;
      const closed = events.readyState === EventSource.CLOSED;
      $("#conn-label").textContent = closed ? t("web.conn.closed") : t("web.conn.lost");
      $("#reload").hidden = !closed;
      $("#conn-spinner").hidden = closed;
    };
  };
  connect();
}
