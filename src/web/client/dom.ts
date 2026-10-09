import type { AgentId, AgentStatus, TurnResult } from "../../agents/agent-adapter.js";
import type { MessageKey } from "../../i18n/messages.js";
import type { SendKey } from "./send-key.js";
import type { ClientContext } from "./store.js";

export function createDom(ctx: ClientContext) {
  type Theme = (typeof ctx.THEMES)[number];

  // 画面の言語の文言（i18n/i18n.ts の format と同じ置き換え）
  const t = (key: MessageKey, params: Record<string, string | number> = {}) =>
    ctx.messages[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
  const displayDefault = (value: string | undefined) => !value || value === "default" ? t("web.agent.default") : value;
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

  const THEME_LABEL: Record<Theme, MessageKey> = { system: "web.settings.themeSystem", light: "web.settings.themeLight", dark: "web.settings.themeDark" };
  const STATUS_LABEL: Record<AgentStatus, MessageKey> = { busy: "web.status.busy", idle: "web.status.idle", starting: "web.status.starting", stopped: "web.status.stopped" };
  const TURN_LABEL: Record<"working" | TurnResult["status"], MessageKey | undefined> = { working: "web.status.busy", interrupted: "web.turn.interrupted", failed: "web.turn.failed", completed: undefined };
  const MOBILE_QUERY = "(max-width: 899px), (pointer: coarse)";
  const mobile = window.matchMedia(MOBILE_QUERY);
  const wideUsage = window.matchMedia(`(min-width: ${ctx.layout.wideUsageMinWidth}px) and (hover: hover) and (pointer: fine)`);
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
  // 候補の行をタップとみなす指の動きの上限（これを超えたら一覧のスクロール）
  const SUGGEST_TAP_SLOP_PX = 10;
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
    remove: (key: string) => { try { localStorage.removeItem(key); } catch { /* 保存できなくても動く */ } },
    keys: () => { try { return Object.keys(localStorage); } catch { return [] as string[]; } },
  };
  const mark = (agent: AgentId | "you") => {
    const node = el("span", `mark ${agent}`, agent === "you" ? "Y" : AGENTS[agent].mark);
    node.setAttribute("aria-hidden", "true");
    return node;
  };
  return { storage, DETAIL_KEY, $, t, INTERRUPT_RETRY_MS, SETTING_TIMEOUT_MS, THEMES, THEME_KEY, SEND_KEYS, SEND_KEY_KEY, THEME_LABEL, icon, el, TOAST_EXIT_MS, TOAST_DURATION_MS, MAX_TOASTS, MS_PER_SECOND, SECONDS_PER_MINUTE, mark, AGENTS, clock, TURN_LABEL, NEAR_BOTTOM_PX, CODE_FOLD_LINES, iconButton, AGENT_IDS, shortDate, kTokens, PERCENT, displayDefault, STATUS_LABEL, mobile, wideUsage, USAGE_POPOVER_GAP_PX, REFERENCES_SEPARATOR, ARTIFACT_LABEL, PERMISSIONS, EFFORTS, SWIPE_CLOSE_PX, KEYBOARD_THRESHOLD_PX, SUGGEST_TAP_SLOP_PX, FILES_REFRESH_MS, HISTORY_THRESHOLD_PX, RELOAD_DELAY_MS };
}
