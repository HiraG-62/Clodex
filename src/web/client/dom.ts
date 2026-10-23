import { AGENT_IDS, type AgentId, type AgentStatus, type TurnResult } from "../../agents/agent-adapter.js";
import { AGENT_META, agentRecord } from "../../agents/agent-meta.js";
import type { MessageKey } from "../../i18n/messages.js";
import type { SendKey } from "./send-key.js";
import type { ClientContext } from "./store.js";
import { formatTokens } from "./token-format.js";

const GOOGLE_G_PATHS = [
  { fill: "#4285F4", d: "M21.35 11.1H12v3.8h5.35c-.23 1.24-.93 2.3-1.99 3.01v2.5h3.22c1.88-1.73 2.97-4.28 2.97-7.31 0-.68-.07-1.34-.2-2z" },
  { fill: "#34A853", d: "M12 22c2.7 0 4.96-.9 6.61-2.43l-3.22-2.5c-.9.6-2.05.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H3.08v2.58C4.72 19.77 8.08 22 12 22z" },
  { fill: "#FBBC05", d: "M6.4 13.91A5.98 5.98 0 0 1 6.09 12c0-.66.11-1.3.31-1.91V7.51H3.08A9.96 9.96 0 0 0 2 12c0 1.61.38 3.13 1.08 4.49l3.32-2.58z" },
  { fill: "#EA4335", d: "M12 5.96c1.43 0 2.72.49 3.74 1.47l2.8-2.8C16.84 3.03 14.58 2 12 2c-3.92 0-7.28 2.23-8.92 5.51L6.4 10.1c.79-2.36 3-4.14 5.6-4.14z" },
] as const;

export function createDom(ctx: ClientContext) {
  type Theme = (typeof ctx.THEMES)[number];

  // 画面の言語の文言（i18n/i18n.ts の format と同じ置き換え）
  const t = (key: MessageKey, params: Record<string, string | number> = {}) =>
    ctx.messages[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
  const displayDefault = (value: string | undefined) => (!value || value === "default" ? t("web.agent.default") : value);
  const AGENTS = agentRecord(id => ({ name: AGENT_META[id].name, mark: AGENT_META[id].ideaPrefix }));
  const PERMISSIONS = ["read-only", "edit", "full"] as const;
  const EFFORTS = agentRecord(id => AGENT_META[id].effortLevels);
  const THEMES = ["system", "light", "dark"] as const;

  const THEME_LABEL: Record<Theme, MessageKey> = { system: "web.settings.themeSystem", light: "web.settings.themeLight", dark: "web.settings.themeDark" };
  const STATUS_LABEL: Record<AgentStatus, MessageKey> = {
    busy: "web.status.busy",
    idle: "web.status.idle",
    starting: "web.status.starting",
    stopped: "web.status.stopped",
  };
  const TURN_LABEL: Record<"working" | TurnResult["status"], MessageKey | undefined> = {
    working: "web.status.busy",
    interrupted: "web.turn.interrupted",
    failed: "web.turn.failed",
    completed: undefined,
  };
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
  const MS_PER_SECOND = 1000;
  const SECONDS_PER_MINUTE = 60;
  const PERCENT = 100;
  // @path の候補を取り直す間隔（入力欄に入るたびに取ると重い）
  const FILES_REFRESH_MS = 30_000;
  // 候補の行をタップとみなす指の動きの上限（これを超えたら一覧のスクロール）
  const SUGGEST_TAP_SLOP_PX = 10;
  // @path の参照として本文の末尾に足された部分（cli/file-references.ts）。編集で入力欄に戻すときは外す
  const REFERENCES_SEPARATOR = "\n\nReferenced files:\n";
  const ARTIFACT_LABEL: Record<"changed" | "referenced" | "image", MessageKey> = {
    changed: "web.artifact.changed",
    referenced: "web.artifact.referenced",
    image: "web.artifact.image",
  };
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
  const kTokens = formatTokens;
  const storage = {
    get: (key: string) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key: string, value: string) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* 保存できなくても動く */
      }
    },
    remove: (key: string) => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* 保存できなくても動く */
      }
    },
    keys: () => {
      try {
        return Object.keys(localStorage);
      } catch {
        return [] as string[];
      }
    },
  };
  const mark = (agent: AgentId | "you") => {
    const node = el("span", `mark ${agent}`, agent === "gemini" ? undefined : agent === "you" ? "Y" : AGENTS[agent].mark);
    if (agent !== "you") node.dataset.agent = agent;
    node.setAttribute("aria-hidden", "true");
    if (agent === "gemini") {
      node.style.background = "#fff";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "82%");
      svg.setAttribute("height", "82%");
      for (const { fill, d } of GOOGLE_G_PATHS) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("fill", fill);
        path.setAttribute("d", d);
        svg.append(path);
      }
      node.append(svg);
    }
    return node;
  };
  return {
    storage,
    DETAIL_KEY,
    $,
    t,
    INTERRUPT_RETRY_MS,
    SETTING_TIMEOUT_MS,
    THEMES,
    THEME_KEY,
    SEND_KEYS,
    SEND_KEY_KEY,
    THEME_LABEL,
    icon,
    el,
    TOAST_EXIT_MS,
    TOAST_DURATION_MS,
    MAX_TOASTS,
    MS_PER_SECOND,
    SECONDS_PER_MINUTE,
    mark,
    AGENTS,
    clock,
    TURN_LABEL,
    NEAR_BOTTOM_PX,
    CODE_FOLD_LINES,
    iconButton,
    AGENT_IDS,
    shortDate,
    kTokens,
    PERCENT,
    displayDefault,
    STATUS_LABEL,
    mobile,
    wideUsage,
    USAGE_POPOVER_GAP_PX,
    REFERENCES_SEPARATOR,
    ARTIFACT_LABEL,
    PERMISSIONS,
    EFFORTS,
    SWIPE_CLOSE_PX,
    KEYBOARD_THRESHOLD_PX,
    SUGGEST_TAP_SLOP_PX,
    FILES_REFRESH_MS,
    HISTORY_THRESHOLD_PX,
    RELOAD_DELAY_MS,
  };
}
