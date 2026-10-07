import { resolvePendingSettings, isNavigationCommand, nextCommandStart } from "./client/pending.js";
import { UI_ICONS } from "./web-icons.js";
// Web UI の画面（DESIGN.md §17 Web UI）。HTML 1 枚に CSS と JS を inline で持つ。
// 画面の振る舞いは src/web/client/ に型付きで書き、関数のソースをそのまま埋め込む
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { slashCommands } from "../cli/commands.js";
import type { Language } from "../context/language.js";
import { MESSAGES } from "../i18n/i18n.js";
import type { MessageKey, Messages } from "../i18n/messages.js";
import { clientMain } from "./client/client-main.js";
import { createInputAssist } from "./client/input-assist.js";
import { collectArtifacts, displayPath, findImagePaths } from "./client/artifacts.js";
import { renderMarkdown } from "./client/markdown.js";
import { applyFeedItem, rebuildTimeline, withStartingTurns } from "./client/timeline.js";
import { composeInputLine } from "./client/compose-input.js";
import { isShellInput } from "./client/shell-input.js";
import { chooseProjectPath } from "./client/project-picker.js";
import { updateDesktopNotify } from "./client/desktop-notify.js";

const STYLE = `
  :root {
    --r-outer: 8px; --r: 6px; --r-inner: 4px; --r-pill: 999px;
    --ring: 0 0 0 1px var(--line); --ring-strong: 0 0 0 1px var(--line-strong);
    --hover-bg: color-mix(in srgb, var(--fg) 6%, transparent); --press-bg: color-mix(in srgb, var(--fg) 10%, transparent);
    --accent: var(--claude); --accent-soft: color-mix(in srgb, var(--accent) 18%, transparent);
    --shadow-pop: 0 12px 32px var(--scrim), var(--ring); --ease: 120ms cubic-bezier(.2, .7, .3, 1);
    --bg: #fafafa; --panel: #ffffff; --sunken: #f2f2f3; --line: #e6e6e8; --line-strong: #d4d4d8;
    --fg: #111113; --fg-2: #3f3f46; --muted: #80808a;
    --claude: #b4793f; --codex: #4b6fa5; --code: #6f9a5a;
    --invert-bg: #111113; --invert-fg: #fafafa;
    --warn: #b7791f; --crit: #d14343; --scrim: rgba(17, 17, 19, .32);
    --font-ui: "Geist", "Zen Kaku Gothic New", system-ui, sans-serif;
    --font-mono: "Geist Mono", "Zen Kaku Gothic New", ui-monospace, monospace;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg: #0b0b0c; --panel: #111113; --sunken: #18181b; --line: #232326; --line-strong: #2f2f34;
    --fg: #f4f4f5; --fg-2: #c8c8cd; --muted: #7c7c86;
    --claude: #d7a26d; --codex: #8aa9d8;
    --invert-bg: #f4f4f5; --invert-fg: #0b0b0c;
    --warn: #e0a84a; --crit: #ef6b6b; --scrim: rgba(0, 0, 0, .55); color-scheme: dark;
  } }
  :root[data-theme="dark"] {
    --bg: #0b0b0c; --panel: #111113; --sunken: #18181b; --line: #232326; --line-strong: #2f2f34;
    --fg: #f4f4f5; --fg-2: #c8c8cd; --muted: #7c7c86;
    --claude: #d7a26d; --codex: #8aa9d8;
    --invert-bg: #f4f4f5; --invert-fg: #0b0b0c;
    --warn: #e0a84a; --crit: #ef6b6b; --scrim: rgba(0, 0, 0, .55); color-scheme: dark;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--fg); font-family: var(--font-ui); font-size: 14.5px; line-height: 1.6;
    -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:disabled { cursor: default; opacity: .4; }
  :focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); } .small { font-size: 12.5px; }
  .c-claude { color: var(--claude); } .c-codex { color: var(--codex); }

  .mark { width: 22px; height: 22px; border-radius: 5px; display: inline-grid; place-items: center; flex: none;
    font: 600 11px/1 var(--font-mono); color: var(--invert-fg); }
  .mark.claude { background: var(--claude); } .mark.codex { background: var(--codex); } .mark.you { background: var(--fg); }

  .topbar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; padding-top: max(10px, env(safe-area-inset-top));
    border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }
  .brand { font-weight: 600; letter-spacing: -.01em; font-size: 15px; }
  .path { color: var(--muted); font-size: 12px; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #projects { max-width: min(32vw, 280px); min-width: 100px; border: 1px solid var(--line); border-radius: 6px;
    background: var(--panel); color: var(--fg); padding: 5px; font-size: 13px; }
  #projects[hidden] { display: none; }
  .ghost { border: 1px solid var(--line); background: transparent; border-radius: 6px; padding: 5px 10px; font-size: 13px; color: var(--fg-2); flex: none; }
  .ghost[aria-pressed="true"] { background: var(--invert-bg); color: var(--invert-fg); border-color: var(--invert-bg); }

  .status { display: grid; background: var(--panel); border-bottom: 1px solid var(--line); }
  .status-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 9px 16px;
    border: 0; background: transparent; text-align: left; width: 100%; }
  .status-row + .status-row { border-top: 1px solid var(--line); }
  .status-row:active { background: var(--sunken); }
  .figs { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12px; color: var(--muted); min-width: 0; }
  .figs b { color: var(--fg-2); font-weight: 500; }
  .figs .name { font-weight: 600; font-size: 13px; }
  .state { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .state.working { color: var(--fg); position: relative; padding-bottom: 3px; }
  .state.working::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 1px;
    background: linear-gradient(90deg, transparent, var(--fg), transparent); background-size: 200% 100%; animation: sweep 1.6s linear infinite; }
  .state.interrupted { color: var(--warn); } .state.failed { color: var(--crit); }
  @keyframes sweep { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  @media (prefers-reduced-motion: reduce) { .state.working::after { animation: none; } }

  .side { display: none; flex-direction: column; gap: 28px; padding: 20px; background: var(--panel); }
  .agent h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .agent h2 .state { margin-left: auto; }
  .role { color: var(--muted); font-size: 12px; margin: -6px 0 12px; overflow-wrap: anywhere; }
  .role-button { border: 0; background: transparent; color: var(--muted); font-size: 15px; padding: 2px 5px; border-radius: 5px; }
  .role-button:hover { color: var(--fg); background: var(--sunken); }
  .role-editor { width: 100%; min-height: 140px; resize: vertical; border: 1px solid var(--line-strong); border-radius: 8px;
    background: var(--panel); color: var(--fg); padding: 10px; font: inherit; }
  .agent .role { margin-left: 30px; }
  .setting-chips { display: flex; gap: 5px; flex-wrap: wrap; margin: -4px 0 14px; }
  .setting-chip { border: 1px solid var(--line); background: var(--sunken); color: var(--fg-2); border-radius: 999px;
    padding: 3px 8px; font-size: 11px; line-height: 1.35; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .setting-chip.warning { border-color: var(--warn); color: var(--warn); background: transparent; }
  .gauge { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; margin-bottom: 10px; font-size: 12px; }
  .gauge .k { color: var(--muted); }
  .gauge .v { color: var(--fg-2); } .gauge .v.over { color: var(--warn); }
  .track { grid-column: 1 / -1; height: 2px; background: var(--line); position: relative; }
  .track > i { position: absolute; inset: 0 auto 0 0; background: var(--fg); }
  .track.claude > i { background: var(--claude); } .track.codex > i { background: var(--codex); }
  .track .tick { position: absolute; top: -3px; width: 1px; height: 8px; background: var(--muted); }
  .eyebrow { font-size: 11px; color: var(--muted); letter-spacing: .06em; text-transform: uppercase; margin: 14px 0 6px; }
  .seg { display: grid; grid-auto-columns: minmax(0, 1fr); grid-auto-flow: column; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .seg button { border: 0; background: transparent; padding: 7px 4px; font-size: 12.5px; color: var(--muted); min-height: 36px; }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button[aria-pressed="true"] { background: var(--invert-bg); color: var(--invert-fg); }
  .links { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 12px; font-size: 13px; }
  .links button { border: 0; background: none; padding: 6px 0; color: var(--fg-2); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line-strong); }
  .links button.danger { color: var(--crit); text-decoration-color: currentColor; }
  .side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ghost.small { padding: 4px 10px; font-size: 12px; }
  .conv-row { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .conv-row .conv { flex: 1; }
  .conv-row.busy .conv .m { color: var(--fg-2); }
  .conv-row.busy .conv .t::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--claude); margin-right: 6px; vertical-align: middle; }
  .conv-menu { flex: none; border: 0; background: transparent; color: var(--muted); border-radius: 6px; padding: 6px 8px; font-size: 15px; line-height: 1; }
  .conv-menu:hover { background: var(--sunken); color: var(--fg); }
  .badge { font: 600 11px/1 var(--font-mono); padding: 3px 6px; border-radius: 4px; background: var(--crit); color: var(--invert-fg); }
  .model-form { display: flex; gap: 6px; }
  .model-form input, .model-form select { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font: 14px var(--font-mono); background: var(--panel); color: var(--fg); }
  .model-form button { border: 1px solid var(--line); border-radius: 6px; padding: 8px 14px; background: var(--invert-bg); color: var(--invert-fg); font-weight: 600; font-size: 13px; }
  .secondary-action { width: 100%; margin: 14px 0 4px; border: 1px solid var(--line-strong); border-radius: 8px; padding: 10px; background: var(--panel); color: var(--fg); font-weight: 500; }
  .secondary-action.danger { color: var(--crit); border-color: currentColor; }
  .small { font-size: 12px; }
  .conv { display: grid; gap: 1px; padding: 8px 10px; border-radius: 6px; font-size: 13px; border: 0; background: transparent; text-align: left; width: 100%; min-width: 0; }
  .conv:hover:not(:disabled) { background: var(--sunken); }
  .conv.current { background: var(--sunken); }
  .conv:disabled { opacity: 1; }
  .conv .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv .m { color: var(--muted); font-size: 11.5px; }

  .log-wrap { position: relative; min-height: 0; display: grid; }
  .log { overflow-y: auto; overscroll-behavior: contain; padding: 4px 16px 24px; display: grid; align-content: start; min-width: 0; }
  .empty { margin: 32px auto; max-width: 320px; text-align: center; color: var(--muted); font-size: 13px; }
  .empty b { display: block; color: var(--fg); font-size: 15px; margin-bottom: 4px; }
  .entry { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 4px 12px; padding: 14px 0; border-bottom: 1px solid var(--line); }
  .entry .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 13px; min-width: 0; }
  .entry .head b { font-weight: 600; }
  .entry .head time { color: var(--muted); font-size: 12px; }
  .entry .body { grid-column: 2; min-width: 0; overflow-wrap: anywhere; color: var(--fg-2); }
  .entry.you .body { color: var(--fg); }
  .md > * { margin: 0 0 8px; } .md > *:last-child { margin-bottom: 0; }
  .md .md-h { font-weight: 600; color: var(--fg); }
  .md blockquote { border-left: 2px solid var(--line-strong); padding-left: 12px; margin-left: 0; color: var(--muted); }
  .md table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; }
  .md th, .md td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
  .md hr { border: 0; border-top: 1px solid var(--line-strong); }
  .md ul, .md ol { padding-left: 1.3em; }
  .md pre { padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; font: 12.5px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--sunken); }
  .md pre code { padding: 0; background: none; }
  code { font-family: var(--font-mono); font-size: .92em; padding: 1px 5px; border-radius: 4px; background: var(--sunken); color: var(--code); overflow-wrap: anywhere; }

  .steps { grid-column: 2; margin: 2px 0 6px; min-width: 0; }
  .steps summary, .envelope summary { list-style: none; cursor: pointer; font-size: 12px; color: var(--muted); display: inline-flex; gap: 6px; padding: 2px 0; }
  .steps summary::-webkit-details-marker, .envelope summary::-webkit-details-marker { display: none; }
  .steps summary::after, .envelope summary::after { content: "+"; font-family: var(--font-mono); }
  .steps[open] summary::after, .envelope[open] summary::after { content: "−"; }
  .steps ol { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
  .steps li { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 8px; font-size: 12.5px; }
  .steps .k { color: var(--muted); font-family: var(--font-mono); font-size: 11px; padding-top: 2px; overflow: hidden; }
  .steps .run { font-family: var(--font-mono); font-size: 12px; color: var(--fg-2); white-space: pre-wrap; overflow-wrap: anywhere; }
  .steps .say { color: var(--fg-2); overflow-wrap: anywhere; white-space: pre-wrap; }

  .handoff { padding: 14px 0; border-bottom: 1px solid var(--line); display: grid; gap: 8px; min-width: 0; }
  .handoff > * { min-width: 0; }
  .handoff .route { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13px; }
  .handoff .arrow { color: var(--muted); }
  .kind { font: 500 11px/1 var(--font-mono); letter-spacing: .04em; padding: 4px 6px; border: 1px solid var(--line-strong); border-radius: 4px; color: var(--fg-2); }
  .handoff .task { margin-left: auto; color: var(--muted); font-size: 12px; }
  .handoff .text { color: var(--fg); overflow-wrap: anywhere; }
  .refs { display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .ref { font: 12px/1.4 var(--font-mono); color: var(--fg-2); overflow-wrap: anywhere; border: 0; background: none; padding: 0; text-align: left; cursor: pointer; text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
  .image-previews { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; min-width: 0; }
  .entry .image-previews { grid-column: 2; }
  .image-previews:empty { display: none; }
  .image-preview { max-width: 100%; min-width: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--sunken); }
  .image-preview img { display: block; max-height: 160px; max-width: 100%; object-fit: contain; }
  .artifact { display: flex; align-items: baseline; gap: 10px; width: 100%; border: 0; background: transparent; padding: 9px 4px; border-bottom: 1px solid var(--line); text-align: left; min-width: 0; }
  .artifact:hover { background: var(--sunken); }
  .artifact .kind { flex: none; font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--sunken); color: var(--fg-2); }
  .artifact .kind.changed { background: color-mix(in srgb, var(--claude) 22%, transparent); }
  .artifact .kind.image { background: color-mix(in srgb, var(--warn) 24%, transparent); }
  .artifact .path { font-size: 12.5px; overflow-wrap: anywhere; min-width: 0; }
  .viewer { margin-top: 10px; min-width: 0; }
  .viewer img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
  .viewer .code { margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; font: 12px/1.55 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--sunken); }
  .viewer .diff .add { color: #1a7f37; } .viewer .diff .del { color: var(--crit); } .viewer .diff .hunk { color: var(--muted); }
  .ref::before { content: "↳ "; color: var(--muted); }
  .finding { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; padding: 10px 12px; border-left: 2px solid var(--warn); background: var(--sunken); border-radius: 0 6px 6px 0; font-size: 13px; }
  .finding.high, .finding.critical { border-left-color: var(--crit); }
  .finding .sev { font: 500 11px/1.6 var(--font-mono); color: var(--warn); text-transform: uppercase; }
  .finding.high .sev, .finding.critical .sev { color: var(--crit); }
  .finding.low .sev { color: var(--muted); }
  .finding .loc { font: 12px/1.6 var(--font-mono); color: var(--muted); overflow-wrap: anywhere; }
  .finding .desc { grid-column: 2; color: var(--fg); overflow-wrap: anywhere; }
  .envelope pre { margin: 8px 0 0; padding: 12px; border: 1px solid var(--line); border-radius: 6px; font: 12px/1.6 var(--font-mono); color: var(--fg-2); white-space: pre-wrap; overflow-wrap: anywhere; }

  .notice, .error-row { padding: 10px 0; font-size: 12.5px; display: flex; gap: 8px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; min-width: 0; }
  .notice { color: var(--warn); } .error-row { color: var(--crit); }
  .notice::before, .error-row::before { content: "!"; font: 600 11px/18px var(--font-mono); width: 18px; height: 18px; text-align: center; border: 1px solid currentColor; border-radius: 50%; flex: none; }
  .kind.steer { color: var(--crit); border-color: currentColor; }
  .plan { grid-column: 2; min-width: 0; overflow-wrap: anywhere; color: var(--muted); font-size: 13.5px; }
  .now { grid-column: 2; display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: 12.5px; color: var(--muted); }
  .now .k { flex: none; }
  .now .what { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .elapsed { font-size: 11.5px; color: var(--muted); }
  .output { margin: 0; padding: 12px 0; border-bottom: 1px solid var(--line); font: 12px/1.6 var(--font-mono); color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }

  .newer { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); border: 0; border-radius: 999px; padding: 6px 14px;
    font-size: 12.5px; font-weight: 600; background: var(--invert-bg); color: var(--invert-fg); box-shadow: 0 4px 16px rgba(0,0,0,.18); }

  .composer { padding: 10px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom)); background: var(--bg); margin: 0; }
  .box { border: 1px solid var(--line-strong); border-radius: 10px; background: var(--panel); display: grid; }
  .box:focus-within { border-color: var(--fg-2); }
  .shell-input .box { border-color: var(--code); box-shadow: inset 3px 0 var(--code); }
  /* 後ろの .box textarea の font: inherit に負けないよう詳細度を上げる */
  .shell-input .box .input-highlight, .shell-input .box textarea { font-family: var(--font-mono); }
  .shell-input .to { opacity: .45; }
  .shell-input-label { color: var(--code); font-size: 12px; margin-bottom: 5px; }
  .input-wrap { position: relative; min-width: 0; }
  /* textarea の背後に同じ折り返しで描き、指定した語の背景だけを見せる */
  .input-highlight, .box textarea { padding: 12px 14px 4px; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; scrollbar-gutter: stable; }
  .input-highlight { position: absolute; inset: 0; width: 100%; height: 100%; color: transparent; pointer-events: none; overflow: hidden; }
  .input-highlight mark { color: transparent; border-radius: 3px; }
  .input-highlight .hl-command { background: color-mix(in srgb, var(--fg) 14%, transparent); }
  .input-highlight .hl-claude { background: color-mix(in srgb, var(--claude) 26%, transparent); }
  .input-highlight .hl-codex { background: color-mix(in srgb, var(--codex) 26%, transparent); }
  .input-highlight .hl-file { background: color-mix(in srgb, var(--warn) 24%, transparent); }
  .box textarea { position: relative; display: block; width: 100%; border: 0; background: transparent; resize: none; color: var(--fg);
    min-height: 44px; max-height: 40vh; outline: none; overflow-y: hidden; }
  .pending { list-style: none; margin: 0; padding: 6px 8px; border-bottom: 1px solid var(--line); display: grid; gap: 4px; }
  .pending li { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12.5px; }
  .pending .who { flex: none; color: var(--muted); }
  .pending .text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pending button { flex: none; border: 1px solid var(--line); background: var(--panel); border-radius: 5px; padding: 3px 8px; font-size: 12px; color: var(--fg); }
  .suggest { list-style: none; margin: 0; padding: 4px; border-bottom: 1px solid var(--line); max-height: 40vh; overflow-y: auto; }
  .suggest li { display: flex; align-items: baseline; gap: 10px; padding: 7px 10px; border-radius: 6px; cursor: pointer; min-width: 0; }
  .suggest li[aria-selected="true"] { background: var(--sunken); }
  .suggest .l { font: 13px/1.4 var(--font-mono); color: var(--fg); overflow-wrap: anywhere; }
  .suggest .d { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .box textarea::placeholder { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .box .bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px 10px; }
  .to { display: inline-flex; gap: 2px; padding: 2px; background: var(--sunken); border-radius: 6px; }
  .to button { border: 0; background: transparent; border-radius: 4px; padding: 5px 10px; font-size: 12.5px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
  .to button::before { content: ""; width: 6px; height: 6px; border-radius: 1px; background: currentColor; opacity: .5; }
  .to button[aria-pressed="true"] { background: var(--panel); color: var(--fg); box-shadow: 0 0 0 1px var(--line); }
  .to button[data-agent="claude"][aria-pressed="true"]::before { background: var(--claude); opacity: 1; }
  .to button[data-agent="codex"][aria-pressed="true"]::before { background: var(--codex); opacity: 1; }
  .attach { margin-left: auto; border: 1px solid var(--line); background: var(--panel); border-radius: 6px; padding: 7px 12px; font-size: 12.5px; color: var(--fg-2); }
  .attach + input + .send { margin-left: 0; }
  .send { margin-left: auto; border: 0; border-radius: 6px; padding: 8px 16px; font-weight: 600; font-size: 13px; background: var(--invert-bg); color: var(--invert-fg); }

  .conn { padding: 6px 16px; font-size: 12.5px; background: var(--warn); color: var(--invert-fg); text-align: center; }
  .toast { position: fixed; left: 50%; top: calc(12px + env(safe-area-inset-top)); transform: translateX(-50%);
    display: grid; gap: 8px; max-width: calc(100% - 32px); z-index: 30; }
  .toast-item { padding: 8px 14px; border: 0; border-radius: 8px; background: var(--invert-bg); color: var(--invert-fg); font-size: 13px; cursor: pointer; }
  .toast-item.warn { background: var(--warn); }
  @media (min-width: 800px) { .toast { left: auto; right: 16px; transform: none; max-width: 420px; } }

  .sheet { position: fixed; inset: 0; z-index: 20; display: grid; align-items: end; }
  .sheet-backdrop { position: absolute; inset: 0; background: var(--scrim); border: 0; }
  .sheet-panel { position: relative; background: var(--panel); border-radius: 14px 14px 0 0; max-height: 80vh; overflow-y: auto;
    padding: 8px 16px; padding-bottom: max(20px, env(safe-area-inset-bottom)); width: 100%; max-width: 560px; margin: 0 auto; }
  .sheet-panel.wide { max-width: 960px; }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 0 4px; }
  .sheet-head h2 { margin: 0; font-size: 15px; }
  .sheet-close { border: 0; background: none; color: var(--muted); font-size: 13px; padding: 8px 0 8px 12px; }
  .primary-action { width: 100%; margin: 8px 0 12px; border: 0; border-radius: 8px; padding: 10px; font-weight: 600; background: var(--invert-bg); color: var(--invert-fg); }
  .setting { margin-bottom: 4px; }
  .entry.question > :not(.mark) { grid-column: 2; min-width: 0; }
  .question-field { display: grid; gap: 8px; margin: 12px 0; }
  .question-field > .kind { justify-self: start; }
  .question-text { margin: 0; white-space: pre-wrap; }
  .question-options { display: grid; gap: 6px; }
  .question-option { display: grid; gap: 4px; text-align: left; white-space: pre-wrap; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--fg); }
  .question-option.selected { border-color: currentColor; background: var(--bg); }
  .question-other { width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--fg); }
  .question-submit { justify-self: start; padding: 8px 16px; border: 0; border-radius: 6px; background: var(--invert-bg); color: var(--invert-fg); }
  .question-submit:disabled { opacity: .5; }
  .question-answered { margin: 0; white-space: pre-wrap; }
  .working-tabs { position: fixed; right: 0; top: 42%; z-index: 12; display: flex; gap: 6px; }
  .working-tab { writing-mode: vertical-rl; border: 1px solid var(--line-strong);
    border-radius: 8px 0 0 8px; background: var(--panel); color: var(--fg-2); padding: 12px 7px; font-size: 12px; box-shadow: 0 3px 14px rgba(0,0,0,.08); }
  .working-panel { position: fixed; right: 0; top: 12%; bottom: 10%; width: min(340px, 92vw); z-index: 13;
    border: 1px solid var(--line); border-radius: 12px 0 0 12px; background: var(--panel); box-shadow: -6px 0 30px rgba(0,0,0,.14);
    padding: 18px; overflow-y: auto; }
  .working-panel-head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; margin-bottom: 12px; }
  .working-panel-head button { border: 0; background: transparent; color: var(--muted); font-size: 18px; }
  .working-list { display: grid; gap: 8px; }
  .working-entry { display: grid; gap: 5px; width: 100%; text-align: left; border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg); padding: 10px; font-size: 12px; }
  .working-entry .name { font-weight: 600; color: var(--fg); }
  .working-entry .work { color: var(--fg-2); overflow-wrap: anywhere; }
  .working-entry .plan { color: var(--muted); overflow-wrap: anywhere; }
  .working-entry .elapsed { color: var(--muted); font-family: var(--font-mono); }

  .app { display: grid; height: 100%; max-width: 1240px; margin: 0 auto; min-width: 0;
    grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto minmax(0, 1fr) auto;
    grid-template-areas: "top" "conn" "status" "log" "compose"; }
  .topbar { grid-area: top; } .conn { grid-area: conn; } .status { grid-area: status; } .log-wrap { grid-area: log; } .composer { grid-area: compose; }
  @media (min-width: 900px) and (hover: hover) and (pointer: fine) {
    .sheet { align-items: center; justify-items: center; }
    .sheet-panel { border-radius: 14px; max-height: 85vh; max-width: 640px; padding-bottom: 20px; }
    .sheet-panel.wide { max-width: 960px; }
    .app { grid-template-columns: 300px minmax(0, 1fr); grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      grid-template-areas: "top top" "conn conn" "side agents" "side log" "side compose"; border-inline: 1px solid var(--line); }
    .side { grid-area: side; display: flex; border-right: 1px solid var(--line); overflow-y: auto; }
    .status { display: none; }
    .log { padding-inline: 32px; } .composer { padding-inline: 32px; }
    #open-conversations { display: none; }
  }
  @media (max-width: 899px), (pointer: coarse) {
    .topbar { flex-wrap: wrap; gap: 6px; }
    .topbar .path { display: none; }
    .working-tabs { top: auto; bottom: calc(96px + env(safe-area-inset-bottom)); right: 12px; }
    .working-tab { writing-mode: horizontal-tb;
      border-radius: 999px; padding: 5px 12px; }
    .working-panel { top: auto; bottom: 0; left: 0; width: 100%; max-height: 65vh; border-radius: 14px 14px 0 0; }
  }

  body[data-to="codex"] { --accent: var(--codex); }
  [data-agent="claude"] { --agent: var(--claude); } [data-agent="codex"] { --agent: var(--codex); }
  button, select, summary { transition: background-color var(--ease), color var(--ease), box-shadow var(--ease), transform var(--ease); }
  button { position: relative; }
  button:hover:not(:disabled), summary:hover { background-color: var(--hover-bg); }
  button:active:not(:disabled), summary:active { background-color: var(--press-bg); transform: scale(.97); }
  button:disabled, button.danger:disabled { color: var(--muted); cursor: default; }
  button[aria-pressed="true"] { background: var(--panel); color: var(--fg); box-shadow: var(--ring); }
  .i { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex: none; padding: 0; border: 0; border-radius: var(--r); background: transparent; color: var(--muted); }
  .icon-btn:hover:not(:disabled) { color: var(--fg); }
  .icon-btn.danger:hover:not(:disabled) { color: var(--crit); }
  .icon-btn:disabled { opacity: .38; }
  .tray { display: flex; gap: 2px; padding: 2px; background: var(--sunken); border-radius: var(--r-outer); }
  .header-tray { margin-left: auto; }
  .topbar { gap: 10px; }
  .project-pill { position: relative; display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 4px 10px; background: var(--sunken); border-radius: var(--r); max-width: 280px; min-width: 100px; }
  #project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  #projects { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; max-width: none; }
  .project-pill:focus-within { outline: 2px solid var(--fg); outline-offset: 2px; }
  .project-pill:hover { box-shadow: var(--ring-strong); }
  .working-tabs { position: static; display: flex; gap: 2px; }
  .working-tab { writing-mode: horizontal-tb; box-shadow: none; padding: 0; border: 0; border-radius: var(--r); }
  .count { position: absolute; top: -2px; right: -2px; min-width: 15px; padding: 1px 3px; border-radius: var(--r-pill); font: 10px var(--font-mono); color: var(--fg); background: var(--panel); box-shadow: var(--ring); }
  .agent-strip { display: none; grid-area: agents; gap: 4px; padding: 8px 16px; min-width: 0; background: var(--bg); border-bottom: 1px solid var(--line); }
  .agent-strip .agent { display: grid; grid-template-columns: minmax(0, 1fr) 136px auto; grid-template-areas: "title gauges actions" "chips gauges actions"; gap: 4px 10px; align-items: center; min-width: 0; background: var(--panel); box-shadow: var(--ring); border-radius: var(--r-outer); padding: 7px 10px; min-height: 52px; }
  .agent-strip h2 { grid-area: title; margin: 0; gap: 6px; font-size: 13px; }
  .agent-strip h2 .mark { width: 22px; height: 22px; font-size: 11px; }
  .agent-strip .controls { display: contents; }
  .setting-chips { margin: 0; }
  .agent-strip .gauge:nth-child(3) { order: -1; }
  .conv .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .setting-chip { display: inline-flex; align-items: center; gap: 4px; border: 0; border-radius: var(--r-inner); padding: 4px 6px; font-size: 11px; }
  .setting-chip .i { width: 13px; height: 13px; color: var(--muted); }
  .setting-chip.warning { color: var(--fg-2); background: var(--sunken); }
  .setting-chip.warning .i { color: var(--warn); }
  .setting-chip:hover:not(:disabled) { background: var(--panel); box-shadow: var(--ring-strong); }
  .agent-strip .setting-chips { grid-area: chips; flex-wrap: nowrap; gap: 3px; min-width: 0; }
  .agent-strip .setting-chip { font-size: 10px; white-space: nowrap; min-width: 0; overflow: hidden; padding: 3px 4px; }
  .mini-gauges { display: grid; gap: 8px; }
  .agent-strip .mini-gauges { grid-area: gauges; gap: 3px; }
  .agent-strip .gauge { grid-template-columns: 32px minmax(0, 1fr) 32px; align-items: center; line-height: 12px; height: 12px; color: var(--muted); }
  .agent-strip .gauge .track { grid-column: 2; grid-row: 1; }
  .agent-strip .gauge .v { grid-column: 3; grid-row: 1; text-align: right; font-size: 0; display: flex; justify-content: flex-end; height: 12px; }
  .agent-strip .gauge .v::after { content: attr(data-compact); font-size: 10.5px; line-height: 12px; }
  .agent-strip .gauge .k { display: none; }
  .agent-strip .gauge::before { grid-column: 1; grid-row: 1; content: attr(data-label); overflow: hidden; white-space: nowrap; }
  .gauge { margin: 0; gap: 4px 5px; font-size: 10.5px; }
  .gauge .k, .gauge .v { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .track { height: 4px; border-radius: var(--r-inner); }
  .track > i { border-radius: inherit; }
  .links { display: flex; gap: 3px; margin-top: 12px; }
  .links .icon-btn { padding: 0; text-decoration: none; }
  .agent-strip .links { grid-area: actions; margin: 0; }
  .agent-strip .links .icon-btn { width: 28px; height: 28px; }
  .agent .state, .status-row .state { display: inline-flex; align-items: center; gap: 6px; padding: 2px 7px; border-radius: var(--r-pill); background: var(--sunken); font-size: 11px; }
  .agent .state::before, .status-row .state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  .agent .state.working::before { background: var(--agent); animation: state-pulse 1.4s infinite; }
  .state.starting::before { background: none; border: 1px dashed var(--agent, var(--muted)); animation: spin .8s linear infinite; }
  .conv-row { border-radius: var(--r-outer); margin: 6px 0; padding: 2px; }
  .conv-row.current { background: var(--panel); box-shadow: var(--ring); }
  .conv-row.current .conv { background: transparent; box-shadow: none; }
  .conv-row .conv:disabled { color: var(--fg); opacity: 1; }
  .conv-row.busy .conv .t::before { background: var(--agent, var(--muted)); }
  .conv-menu { opacity: .55; }
  .conv-row:hover .conv-menu { opacity: 1; }
  .box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .send.icon-btn { background: var(--accent); color: var(--invert-fg); box-shadow: var(--ring); }
  .seg { gap: 2px; padding: 2px; background: var(--sunken); border: 0; border-radius: var(--r); overflow: visible; }
  .seg button { border: 0; border-radius: var(--r-inner); }
  .seg button + button { border: 0; }
  .seg button[aria-pressed="true"] { background: var(--panel); color: var(--fg); box-shadow: var(--ring); }
  .question-options { background: var(--sunken); padding: 3px; border-radius: var(--r-outer); }
  .question-option { background: transparent; border: 0; border-radius: var(--r); }
  .question-option.selected { background: var(--panel); box-shadow: var(--ring); }
  .question-option.selected > :first-child::before { content: ""; display: inline-block; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; margin-right: 7px; }
  .model-form button, .secondary-action { background: var(--panel); color: var(--fg); box-shadow: var(--ring); }
  .toast-item { display: flex; align-items: center; gap: 10px; background: var(--panel); color: var(--fg); box-shadow: var(--shadow-pop); animation: toast-in 150ms ease-out; }
  .toast-item.warn { background: var(--panel); color: var(--warn); }
  .toast-item.leaving { opacity: 0; transform: translateY(-8px); transition: opacity 150ms, transform 150ms; }
  .sheet-panel { animation: sheet-in 150ms ease-out; }
  .is-loading { color: transparent !important; pointer-events: none; }
  .is-loading > * { visibility: hidden; }
  .is-loading::after { content: ""; position: absolute; inset: 0; margin: auto; width: 14px; height: 14px; border: 1.75px solid var(--fg-2); border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes state-pulse { 50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--agent) 20%, transparent); } }
  @keyframes sheet-in { from { opacity: 0; transform: scale(.98); } }
  @keyframes toast-in { from { opacity: 0; transform: translateY(-8px); } }
  @media (min-width: 900px) and (hover: hover) and (pointer: fine) {
    .topbar { height: 52px; padding: 0 12px 0 16px; }
    .side { background: var(--bg); padding: 16px; }
    .composer { padding: 6px 32px 16px; }
    .agent-strip { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .icon-btn[title]:hover::before { content: attr(title); position: absolute; top: calc(100% + 9px); right: 0; z-index: 40; padding: 5px 8px; border-radius: var(--r); background: var(--panel); color: var(--fg); box-shadow: var(--shadow-pop); white-space: nowrap; font-size: 12px; pointer-events: none; animation: tooltip-in 400ms step-end; }
  }
  @media (min-width: 900px) and (max-width: 1199px) { .agent-strip .agent { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "title actions" "chips actions" "gauges gauges"; } .agent-strip .mini-gauges { grid-template-columns: repeat(3,minmax(0,1fr)); } .agent-strip .gauge { grid-template-columns: 1fr auto; } .agent-strip .gauge .track { grid-column: 1 / -1; grid-row: 2; } .agent-strip .gauge .v { grid-column: 2; } }
  @keyframes tooltip-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }

  .topbar { position: relative; }
  .progress { display: none; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; z-index: 5; }
  .progress::before { content: ""; position: absolute; width: 40%; height: 100%; background: var(--accent); animation: progress 1.1s ease-in-out infinite; }
  .initial-loading .progress, .navigation-pending .progress { display: block; }
  .spin { display: inline-block; width: 13px; height: 13px; border: 1.75px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; flex: none; }
  .conn { display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--sunken); color: var(--fg-2); }
  .btn { border: 0; border-radius: var(--r); padding: 7px 12px; background: var(--panel); color: var(--fg); box-shadow: var(--ring); }
  .history-loading, .upload-status { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); padding: 8px; }
  .upload-status { border-radius: var(--r); background: var(--sunken); margin-bottom: 6px; width: fit-content; }
  .log-skeleton { display: grid; gap: 24px; padding: 20px 0; }
  .sk-row { display: flex; gap: 12px; min-height: 64px; }
  .sk { display: block; height: 10px; border-radius: var(--r-inner); background: linear-gradient(90deg,var(--sunken) 20%,var(--line) 45%,var(--sunken) 70%); background-size: 220% 100%; animation: shimmer 1.5s infinite; }
  .sk-avatar { width: 22px; height: 22px; flex: none; }
  .sk-lines { display: grid; gap: 8px; flex: 1; align-content: start; }
  .sk-lines .sk:first-child { width: 120px; }
  .sk-lines .sk:last-child { width: 64%; }
  .sk-row:nth-child(2) { width: 80%; }
  .initial-loading #agents::before, .initial-loading #agents::after, .initial-loading #conversations::before { content: ""; display: block; height: 70px; border-radius: var(--r); background: linear-gradient(90deg,var(--sunken),var(--line),var(--sunken)); background-size: 220% 100%; animation: shimmer 1.5s infinite; }
  .initial-loading #conversations::before { height: 180px; mask-image: repeating-linear-gradient(to bottom,#000 0 15px,transparent 15px 35px); }
  .setting-pending { color: var(--muted); font-size: 11px; display: flex; gap: 6px; align-items: center; margin: 6px 0; }
  .setting-chip.pending { box-shadow: var(--ring-strong); }
  .starting-turn .body { display: flex; gap: 8px; align-items: center; color: var(--muted); }
  .output-clock { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
  @keyframes progress { from { transform: translateX(-100%); } to { transform: translateX(350%); } }
  @keyframes shimmer { from { background-position: 150% 0; } to { background-position: -50% 0; } }
`;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const body = (messages: Messages) => {
  const m = (key: MessageKey) => escapeHtml(messages[key]);
  const icon = (name: string) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const button = (id: string, name: string, key: MessageKey, cls = "", extra = "") =>
    `<button class="icon-btn ${cls}" type="button" id="${id}" aria-label="${m(key)}" title="${m(key)}" ${extra}>${icon(name)}</button>`;
  return `
${UI_ICONS}
<div class="app initial-loading" aria-busy="true">
  <header class="topbar">
    <div class="progress" aria-hidden="true"></div>
    <span class="brand">Clodex</span>
    <div class="project-pill" id="project-pill">${icon("folder")}<span id="project-name"></span>${icon("chevron-down")}<select id="projects" aria-label="${m("web.top.projects")}"></select></div>
    ${button("open-project", "folder-open", "web.top.openProject")}
    <div class="header-tray tray">
      <div class="working-tabs">${button("question-toggle", "question", "web.question.title", "working-tab", 'hidden')}<button class="icon-btn working-tab" id="working-toggle" type="button" aria-expanded="false" aria-label="${m("web.working.title")}" title="${m("web.working.title")}" hidden>${icon("activity")}<span class="count" id="working-count">0</span></button></div>
      ${button("detail", "list-tree", "web.top.detailTitle", "", 'aria-pressed="false"')}
      ${button("open-artifacts", "files", "web.top.artifacts")}
      ${button("open-conversations", "messages", "web.top.conversations")}
      ${button("open-settings", "settings", "web.top.settings")}
    </div>
  </header>
  <div class="conn" id="conn" hidden role="status"><span class="spin" id="conn-spinner"></span><span id="conn-label">${m("web.conn.lost")}</span><button class="btn" id="reload" type="button" hidden>${m("web.conn.reload")}</button></div>
  <div class="status" id="status"></div>
  <section class="agent-strip" id="agents" aria-label="Agent"></section>
  <aside class="side">
    <section>
      <div class="side-head"><div class="eyebrow">${m("web.side.conversations")}</div>${button("new-conversation", "square-pen", "web.side.newConversation")}</div>
      <div id="conversations"></div>
    </section>
  </aside>
  <div class="log-wrap">
    <main class="log" id="log" aria-label="${m("web.log.label")}" aria-live="polite">
      <div class="history-loading" id="history-loading" hidden role="status"><span class="spin"></span>${m("web.history.loading")}</div>
      <div class="log-skeleton" id="log-skeleton" aria-hidden="true">${[0, 1, 2, 3].map(() => '<div class="sk-row"><span class="sk sk-avatar"></span><div class="sk-lines"><span class="sk"></span><span class="sk"></span><span class="sk"></span></div></div>').join("")}</div>
      <div class="empty" id="empty" hidden><b>${m("web.empty.title")}</b></div>
    </main>
    <button class="newer" type="button" id="newer" hidden>${m("web.newer")}</button>
  </div>
  <form class="composer" id="composer">
    <div class="shell-input-label" id="shell-input-label" hidden>${m("web.shellInput")}</div>
    <div class="upload-status" id="upload-status" role="status" hidden><span class="spin"></span>${m("web.upload.loading")}</div>
    <div class="box">
      <ul class="pending" id="pending" aria-label="${m("web.pending.label")}" hidden></ul>
      <ul class="suggest" id="suggest" role="listbox" aria-label="${m("web.suggest.label")}" hidden></ul>
      <div class="input-wrap">
        <div class="input-highlight" id="input-highlight" aria-hidden="true"></div>
        <textarea id="input" rows="1" aria-label="${m("web.input.label")}" enterkeyhint="enter" role="combobox" aria-controls="suggest" aria-expanded="false" aria-autocomplete="list"></textarea>
      </div>
      <div class="bar">
        <div class="to" role="group" aria-label="${m("web.to.label")}">
          <button type="button" data-agent="claude" aria-pressed="true">Claude</button>
          <button type="button" data-agent="codex" aria-pressed="false">Codex</button>
        </div>
        ${button("attach", "image-plus", "web.attach.label", "attach")}
        <input type="file" id="attach-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
        <button class="send icon-btn" type="submit" aria-label="${m("web.send")}" title="${m("web.send")}">${icon("arrow-up")}</button>
      </div>
    </div>
  </form>
</div>
<aside class="working-panel" id="working-panel" hidden aria-label="${m("web.working.title")}">
  <div class="working-panel-head"><span>${m("web.working.title")}</span>${button("working-close", "x", "web.working.close")}</div>
  <div class="working-list" id="working-list"></div>
</aside>
<div class="sheet" id="sheet" hidden>
  <button class="sheet-backdrop" id="sheet-backdrop" type="button" aria-label="${m("web.sheet.close")}"></button>
  <div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <div class="sheet-head"><h2 id="sheet-title"></h2>${button("sheet-close", "x", "web.sheet.close", "sheet-close")}</div>
    <div id="sheet-body"></div>
  </div>
</div>
<div class="toast" id="toast" role="status"></div>
`;
};

// 関数のソースに </script> が含まれていても script 要素が途中で閉じないようにする
const inlineScript = (source: string) => source.replace(/<\/script/gi, "<\\/script");
const MARKED_UMD = inlineScript(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("marked/package.json"))), "lib", "marked.umd.js"), "utf8"));

const PAGE_VERSION_LENGTH = 12;
const CLIENT_SOURCE = inlineScript(clientMain.toString());
const FUNCTIONS = `
  isShellInput: ${inlineScript(isShellInput.toString())},
  renderMarkdown: ${inlineScript(renderMarkdown.toString())},
  applyFeedItem: ${inlineScript(applyFeedItem.toString())},
  rebuildTimeline: ${inlineScript(rebuildTimeline.toString())},
  withStartingTurns: ${inlineScript(withStartingTurns.toString())},
  resolvePendingSettings: ${inlineScript(resolvePendingSettings.toString())},
  isNavigationCommand: ${inlineScript(isNavigationCommand.toString())},
  nextCommandStart: ${inlineScript(nextCommandStart.toString())},
  composeInputLine: ${inlineScript(composeInputLine.toString())},
  createInputAssist: ${inlineScript(createInputAssist.toString())},
  collectArtifacts: ${inlineScript(collectArtifacts.toString())},
  findImagePaths: ${inlineScript(findImagePaths.toString())},
  displayPath: ${inlineScript(displayPath.toString())},
  chooseProjectPath: ${inlineScript(chooseProjectPath.toString())},
  updateDesktopNotify: ${inlineScript(updateDesktopNotify.toString())},`;
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

// ホーム画面に置けるようにする（DESIGN.md §28 D: PWA）
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="100" fill="#000000"/><g fill="#DEA161"><path d="M118 144 199 225Q207 233 207 245V267Q207 279 199 287L118 368Q105 381 92 368L73 349Q60 336 73 323L132 264Q140 256 132 248L73 189Q60 176 73 163L92 144Q105 131 118 144Z"/><rect x="226" y="227" width="60" height="60" rx="12"/></g><path d="M118 144 199 225Q207 233 207 245V267Q207 279 199 287L118 368Q105 381 92 368L73 349Q60 336 73 323L132 264Q140 256 132 248L73 189Q60 176 73 163L92 144Q105 131 118 144Z" transform="translate(512 0) scale(-1 1)" fill="#7CA2DD"/></svg>`;
export const MANIFEST = JSON.stringify({
  name: "Clodex", short_name: "Clodex", start_url: "/", display: "standalone",
  background_color: "#000000", theme_color: "#000000",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
});

export interface WebPage {
  html: string;
  // 画面の中身から決まる版。Clodex を更新して起動し直すと変わり、開いている画面は再読み込みする（DESIGN.md §17）
  version: string;
}

// 言語は起動時に決まる（DESIGN.md §13 Language）
export const buildWebPage = (language: Language): WebPage => {
  const messages = MESSAGES[language];
  const html = body(messages);
  const deps = `${FUNCTIONS}
  commands: ${json(slashCommands())},
  messages: ${json(messages)},`;
  const version = createHash("sha256").update(STYLE).update(html).update(MARKED_UMD).update(CLIENT_SOURCE).update(deps)
    .digest("hex").slice(0, PAGE_VERSION_LENGTH);
  return {
    version,
    html: `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Clodex</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<meta name="theme-color" content="#000000">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap">
<style>${STYLE}</style>
</head>
<body>
${html}
<script>${MARKED_UMD}</script>
<script>
(${CLIENT_SOURCE})({${deps}
  version: "${version}",
});
</script>
</body>
</html>
`,
  };
};
