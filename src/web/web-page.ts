import { WEB_LAYOUT } from "./layout.js";
import { resolvePendingSettings, isNavigationCommand, nextCommandStarts } from "./client/pending.js";
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
import { collectArtifacts, displayPath, findImagePaths, splitImagePaths } from "./client/artifacts.js";
import { renderMarkdown } from "./client/markdown.js";
import { applyFeedItem, rebuildTimeline, withStartingTurns, workingFeed } from "./client/timeline.js";
import { nextUnanswered, questionAnswers } from "./client/question-flow.js";
import { composeInputLine } from "./client/compose-input.js";
import { isSendKey } from "./client/send-key.js";
import { settingsSections } from "./client/settings-sections.js";
import { limitChanges } from "./client/limit-changes.js";
import { fitView, zoomView } from "./client/image-zoom.js";
import { isShellInput } from "./client/shell-input.js";
import { chooseProjectPath } from "./client/project-picker.js";
import { updateDesktopNotify } from "./client/desktop-notify.js";

const STYLE = `
  :root {
    --r-outer: 8px; --r: 6px; --r-inner: 4px; --r-pill: 999px;
    --ring: 0 0 0 1px var(--line); --ring-strong: 0 0 0 1px var(--line-strong);
    --hover-bg: color-mix(in srgb, var(--fg) 6%, transparent); --press-bg: color-mix(in srgb, var(--fg) 10%, transparent);
    --accent: var(--claude);
    --shadow-pop: 0 12px 32px var(--scrim), var(--ring); --ease: 120ms cubic-bezier(.2, .7, .3, 1);
    --bg: #fafafa; --panel: #ffffff; --sunken: #f2f2f3; --line: #e6e6e8; --line-strong: #d4d4d8;
    --fg: #111113; --fg-2: #3f3f46; --muted: #80808a;
    --claude: #b4793f; --codex: #4b6fa5; --code: #6f9a5a; --link: #2563eb;
    --invert-bg: #111113; --invert-fg: #fafafa;
    --warn: #b7791f; --crit: #d14343; --scrim: rgba(17, 17, 19, .32);
    --font-ui: "Geist", "Zen Kaku Gothic New", system-ui, sans-serif;
    --font-mono: "Geist Mono", "Zen Kaku Gothic New", ui-monospace, monospace;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg: #0b0b0c; --panel: #111113; --sunken: #18181b; --line: #232326; --line-strong: #2f2f34;
    --fg: #f4f4f5; --fg-2: #c8c8cd; --muted: #7c7c86;
    --claude: #d7a26d; --codex: #8aa9d8; --link: #7aa7ff;
    --invert-bg: #f4f4f5; --invert-fg: #0b0b0c;
    --warn: #e0a84a; --crit: #ef6b6b; --scrim: rgba(0, 0, 0, .55); color-scheme: dark;
  } }
  :root[data-theme="dark"] {
    --bg: #0b0b0c; --panel: #111113; --sunken: #18181b; --line: #232326; --line-strong: #2f2f34;
    --fg: #f4f4f5; --fg-2: #c8c8cd; --muted: #7c7c86;
    --claude: #d7a26d; --codex: #8aa9d8; --link: #7aa7ff;
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
  .project-list { display: grid; gap: 2px; }
  .project-row { display: grid; grid-template-columns: minmax(0, 1fr) 34px 34px; align-items: center; gap: 2px; padding: 2px 2px 2px 10px; border-radius: var(--r); }
  .project-row.current { background: var(--sunken); }
  .project-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .project-pin[aria-pressed="false"] { color: var(--muted); }
  .project-pin[aria-pressed="true"] .i { fill: currentColor; }
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
  .entry .head .jump { width: 22px; height: 22px; align-self: center; }
  .entry.jumped { animation: jumped 1.6s ease-out; }
  @keyframes jumped { from { background: color-mix(in srgb, var(--accent) 14%, transparent); } }
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
  /* 絶対パスは本文より目立たせない */
  code.path { font-size: .78em; padding: 0; background: none; color: var(--muted); }

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
  .image-preview { cursor: zoom-in; }
  .md a, .image-link { color: var(--link); text-decoration: underline; text-underline-offset: 3px; }
  .image-link { cursor: zoom-in; }
  .md a:hover, .image-link:hover { text-decoration-thickness: 2px; }
  .image-preview img { display: block; max-height: 96px; max-width: 160px; object-fit: contain; }
  .lightbox { position: fixed; inset: 0; z-index: 25; display: grid; grid-template-rows: auto minmax(0, 1fr); background: #0c0c0e; color: #f4f4f5; }
  .lightbox[hidden] { display: none; }
  .lb-bar { display: flex; align-items: center; gap: 8px; padding: max(6px, env(safe-area-inset-top)) 8px 6px 14px; }
  .lb-name { flex: 1; min-width: 0; font-size: 12px; color: rgba(244, 244, 245, .6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lb-tools { display: flex; align-items: center; gap: 2px; }
  .lightbox .icon-btn { color: inherit; }
  .lb-scale { min-width: 52px; padding: 6px; border: 0; border-radius: var(--r); background: none; color: inherit; font: 12px var(--font-mono); cursor: pointer; }
  .lb-scale:hover { background: rgba(255, 255, 255, .1); }
  .lb-stage { position: relative; overflow: hidden; touch-action: none; cursor: grab; }
  .lb-stage.dragging { cursor: grabbing; }
  .lb-stage img { position: absolute; left: 0; top: 0; max-width: none; transform-origin: 0 0; user-select: none; -webkit-user-drag: none; }
  .artifact { display: flex; align-items: baseline; gap: 10px; width: 100%; border: 0; background: transparent; padding: 9px 4px; border-bottom: 1px solid var(--line); text-align: left; min-width: 0; }
  .artifact:hover { background: var(--sunken); }
  .artifact .kind { flex: none; font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--sunken); color: var(--fg-2); }
  .artifact .kind.changed { background: color-mix(in srgb, var(--claude) 22%, transparent); }
  .artifact .kind.image { background: color-mix(in srgb, var(--warn) 24%, transparent); }
  .artifact .path { font-size: 12.5px; overflow-wrap: anywhere; min-width: 0; }
  .viewer { margin-top: 10px; min-width: 0; }
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
  .steer-delivered { display: inline-flex; color: var(--code); }
  .steer-delivered .i { width: 14px; height: 14px; }
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
  .composer.shell-input { --accent: var(--code); }
  .shell-input .box { border-color: var(--code); }
  /* 後ろの .box textarea の font: inherit に負けないよう詳細度を上げる */
  .shell-input .box .input-highlight, .shell-input .box textarea { font-family: var(--font-mono); }
  .target-slot { display: grid; }
  .target-slot > * { grid-area: 1 / 1; }
  .shell-badge { visibility: hidden; justify-self: start; display: inline-flex; align-items: center; padding: 2px; border-radius: var(--r); background: var(--sunken); color: var(--code); font-size: 12.5px; }
  .shell-badge > span { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: var(--r-inner); background: var(--panel); box-shadow: var(--ring); }
  .shell-badge > span::before { content: ""; width: 6px; height: 6px; border-radius: 1px; background: var(--code); }
  .shell-input .target-slot .to { visibility: hidden; }
  .shell-input .shell-badge { visibility: visible; }
  .solo-badge { padding: 3px 8px; border-radius: var(--r-pill); box-shadow: var(--ring); color: var(--muted); font-size: 12px; }
  .solo-badge[hidden] { display: none; }
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
  .box .bar .send { margin-left: 0; }
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
  .question-field > .kind { justify-self: start; border: 0; padding: 0; color: var(--muted); font: 500 11.5px/1.4 var(--font-ui); letter-spacing: 0; }
  .question-text { margin: 0; white-space: pre-wrap; }
  .question-options { display: grid; gap: 6px; }
  .question-option { display: grid; gap: 4px; text-align: left; white-space: pre-wrap; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--fg); }
  .question-option.selected { border-color: currentColor; background: var(--bg); }
  .question-recommended { display: inline-flex; vertical-align: -2px; margin-left: 6px; color: var(--accent); }
  .question-recommended .i { width: 14px; height: 14px; fill: currentColor; }
  .question-other { width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--fg); }
  .question-submit { justify-self: start; padding: 8px 16px; border: 0; border-radius: 6px; background: var(--invert-bg); color: var(--invert-fg); }
  .question-submit:disabled { opacity: .5; }
  .working-tabs { position: fixed; right: 0; top: 42%; z-index: 12; display: flex; gap: 6px; }
  .working-tab { writing-mode: vertical-rl; border: 1px solid var(--line-strong);
    border-radius: 8px 0 0 8px; background: var(--panel); color: var(--fg-2); padding: 12px 7px; font-size: 12px; box-shadow: 0 3px 14px rgba(0,0,0,.08); }
  .working-panel { position: fixed; right: 0; top: 12%; bottom: 10%; width: clamp(340px, 40vw, 640px); z-index: 13;
    border: 1px solid var(--line); border-radius: 12px 0 0 12px; background: var(--panel); box-shadow: -6px 0 30px rgba(0,0,0,.14);
    padding: 18px; overflow-y: auto; }
  .working-panel-head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; margin-bottom: 12px; }
  .working-panel-head button { border: 0; background: transparent; color: var(--muted); font-size: 18px; }
  .working-list { display: grid; gap: 6px; }
  .working-head { display: flex; align-items: baseline; gap: 8px; width: 100%; min-width: 0; text-align: left; border: 0;
    border-top: 1px solid var(--line); background: transparent; padding: 10px 0 2px; font-size: 12px; }
  .working-list > .working-head:first-child { border-top: 0; padding-top: 0; }
  .working-head .name { font-weight: 600; flex: none; }
  .working-head .plan { color: var(--muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .working-head .elapsed { color: var(--muted); font-family: var(--font-mono); flex: none; margin-left: auto; }
  .working-say { color: var(--fg-2); font-size: 13px; overflow-wrap: anywhere; border-left: 2px solid var(--line-strong); padding-left: 10px; }

  .app { display: grid; height: 100%; max-width: ${WEB_LAYOUT.sideWidth + WEB_LAYOUT.chatMaxWidth}px; margin: 0 auto; min-width: 0;
    grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto minmax(0, 1fr) auto;
    grid-template-areas: "top" "conn" "status" "log" "compose"; }
  .topbar { grid-area: top; } .conn { grid-area: conn; } .status { grid-area: status; } .log-wrap { grid-area: log; } .composer { grid-area: compose; }
  @media (min-width: 900px) and (hover: hover) and (pointer: fine) {
    .handoff { grid-template-columns: 22px minmax(0, 1fr); column-gap: 12px; }
    .handoff > :not(.route) { grid-column: 2; }
    .handoff > .route { grid-column: 1 / -1; }
    .sheet { align-items: center; justify-items: center; }
    .sheet-panel { border-radius: 14px; max-height: 85vh; max-width: 640px; padding-bottom: 20px; }
    .sheet-panel.wide { max-width: 960px; }
    .app { grid-template-columns: ${WEB_LAYOUT.sideWidth}px minmax(0, 1fr); grid-template-rows: auto auto auto minmax(0, 1fr) auto;
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
  .box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
  .send.icon-btn { background: var(--accent); color: var(--invert-fg); box-shadow: var(--ring); }
  .shell-input .send.icon-btn:hover:not(:disabled), .shell-input .send.icon-btn:active:not(:disabled) { background: color-mix(in srgb, var(--code) 85%, var(--fg)); }
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
    .composer .icon-btn[title]:hover::before { top: auto; bottom: calc(100% + 9px); }
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
  .setting-pending { color: var(--muted); font-size: 11px; display: flex; gap: 6px; align-items: center; margin: 6px 0; }
  .setting-chip.pending { box-shadow: var(--ring-strong); }
  .starting-turn .body { display: flex; gap: 8px; align-items: center; color: var(--muted); }
  .output-clock { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
  @keyframes progress { from { transform: translateX(-100%); } to { transform: translateX(350%); } }
  @keyframes shimmer { from { background-position: 150% 0; } to { background-position: -50% 0; } }

  .count { background: var(--fg); color: var(--bg); box-shadow: 0 0 0 2px var(--panel); font-weight: 600; }
  .count:empty { display: none; }
  .strip-well { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-column: 1 / -1; gap: 2px; padding: 2px; background: var(--sunken); border-radius: 12px; min-width: 0; }
  .agent-strip .agent { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) 136px auto; grid-template-areas: none; gap: 10px; padding: 7px 8px 7px 10px; align-items: center; min-height: 52px; border-radius: 10px; background: transparent; box-shadow: none; }
  .agent-strip .agent.busy { background: var(--panel); box-shadow: var(--ring); }
  .agent-strip .agent.busy::after { content: ""; position: absolute; inset: auto 0 0; height: 1px; background: linear-gradient(90deg,transparent,var(--agent),transparent); }
  .strip-who { min-width: 0; }
  .agent-strip h2 { grid-area: auto; display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; font-size: 13px; line-height: 20px; }
  .agent-strip h2 .state { margin-left: 0; padding: 0; border-radius: 0; background: transparent; font-weight: 400; font-size: 11.5px; gap: 5px; }
  .agent-strip .state.working::after { display: none; }
  .agent-strip .state .elapsed { font-size: 10.5px; }
  .strip-summary { display: flex; gap: 4px; width: 100%; min-width: 0; padding: 0; border: 0; border-radius: var(--r-inner); background: transparent; color: var(--muted); font: 11.5px/1.4 var(--font-mono); text-align: left; }
  .strip-summary > span { flex: none; white-space: nowrap; }
  .strip-summary .model { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .strip-summary .permission-full { color: var(--warn); }
  .strip-summary.pending { box-shadow: var(--ring); }
  .agent-strip .mini-gauges, .agent-strip .links { grid-area: auto; }
  .agent-strip .mini-gauges { grid-template-columns: minmax(0, 1fr); }
  .agent-strip .gauge { grid-template-columns: 30px minmax(0, 1fr) 30px; }
  .agent-strip .gauge .v { grid-column: 3; }
  .agent-strip .gauge .track { grid-column: 2; grid-row: 1; }
  .agent-strip .track > i { background: var(--fg-2); }
  .question.claude { --accent: var(--claude); } .question.codex { --accent: var(--codex); }
  .question-dock { --accent: var(--agent-color); margin-bottom: 8px; border: 1px solid var(--line-strong); border-top: 2px solid var(--accent);
    border-radius: 10px; background: var(--panel); box-shadow: 0 -4px 18px rgba(0,0,0,.06); }
  .question-dock.claude { --agent-color: var(--claude); } .question-dock.codex { --agent-color: var(--codex); }
  .question-dock-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: 0; background: transparent; color: var(--fg); font-size: 12.5px; text-align: left; }
  .question-dock-head > .i:first-child { width: 15px; height: 15px; color: var(--warn); }
  .question-dock-head > .i:last-child { width: 15px; height: 15px; margin-left: auto; color: var(--muted); transition: transform .15s; }
  .question-dock.collapsed .question-dock-head > .i:last-child { transform: rotate(180deg); }
  .question-dock-body { display: grid; gap: 10px; padding: 0 12px 12px; max-height: 50vh; overflow-y: auto; }
  .question-dock .question-field { margin: 0; }
  .question-dots { display: flex; gap: 6px; }
  .question-dot { width: 22px; height: 6px; padding: 0; border: 0; border-radius: 3px; background: var(--line-strong); }
  .question-dot.answered { background: color-mix(in srgb, var(--accent) 45%, transparent); }
  .question-dot.current { background: var(--accent); }
  .question-nav { display: flex; gap: 8px; align-items: center; }
  .question-nav .question-submit { margin-left: auto; }
  .question-record { display: grid; gap: 2px 0; margin: 4px 0 0; font-size: 13px; }
  .question-record dt { color: var(--muted); }
  .question-record dd { margin: 0 0 6px; white-space: pre-wrap; }
  .question-text { font-weight: 600; }
  .question-option { display: grid; grid-template-columns: 6px minmax(0, 1fr); column-gap: 10px; }
  .question-option::before { content: ""; width: 6px; height: 6px; border-radius: 1px; background: var(--muted); opacity: .5; grid-column: 1; grid-row: 1; align-self: center; }
  .question-option > * { grid-column: 2; }
  .question-option.selected::before { background: var(--accent); opacity: 1; }
  .question-option.selected > :first-child::before { display: none; }

  .strip-skeleton { display: grid; grid-template-columns: 22px minmax(0, 1fr) 136px; align-items: center; gap: 10px; min-height: 56px; padding: 8px 10px; background: var(--panel); border-radius: 10px; }
  .sk-identity { display: grid; gap: 8px; }
  .sk-identity > div { display: flex; align-items: center; gap: 12px; }
  .sk-name { width: 60px; }
  .sk-state { width: 50px; height: 18px; border-radius: var(--r-pill); }
  .sk-settings { width: 90%; }
  .sk-gauges { display: grid; gap: 7px; }
  .sk-gauges .sk { height: 4px; }
  .conv-skeleton { display: grid; gap: 7px; padding: 12px 10px; }
  .conv-skeleton .sk:first-child { width: 80%; }
  .conv-skeleton .sk:last-child { width: 50%; height: 8px; }
  .conv-skeleton:nth-child(2) .sk:first-child { width: 65%; }
  .conv-skeleton:nth-child(3) .sk:first-child { width: 72%; }
  .initial-loading #project-name { width: 68px; height: 10px; border-radius: var(--r-inner); background: linear-gradient(90deg,var(--sunken),var(--line),var(--sunken)); background-size: 220% 100%; animation: shimmer 1.5s infinite; }
  .starting-turn .head .elapsed { margin-left: auto; }
  .starting-turn .state { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; background: var(--sunken); border-radius: var(--r-pill); }
  .starting-turn .state::before { content: ""; width: 9px; height: 9px; border: 1px dashed var(--muted); border-radius: 50%; animation: spin .8s linear infinite; }
  .starting-turn .body { display: grid; gap: 9px; padding: 12px; background: var(--sunken); border-radius: var(--r-outer); }
  .starting-turn .body .sk:first-child { width: 65%; }
  .starting-turn .body .sk:last-child { width: 42%; }
  .agent-strip button.mini-gauges { border: 0; padding: 0; background: transparent; text-align: left; border-radius: var(--r); color: inherit; font: inherit; }
  .agent-strip button.mini-gauges:hover, .agent-strip button.mini-gauges[aria-expanded="true"] { background: var(--hover-bg); box-shadow: var(--ring); }
  .usage-popover { position: fixed; z-index: 18; padding: 16px; display: grid; gap: 16px; background: var(--panel); border-radius: var(--r-outer); box-shadow: var(--shadow-pop); }
  .usage-popover .gauge-reset { display: inline; margin-right: 8px; color: var(--muted); }
  .usage-popover .gauge { font-size: 12px; }
  .usage-popover .gauge .k { overflow: visible; }
  .usage-popover .gauge .track { grid-column: 1 / -1; }
  .usage-side { display: none; }
  .usage-side h2 { display: flex; align-items: center; gap: 8px; font-size: 14px; margin: 0 0 18px; }
  .usage-side section { padding: 20px 16px; border-bottom: 1px solid var(--line); }
  .usage-side .usage-details { display: grid; gap: 16px; }
  .usage-side .gauge-reset { display: inline; margin-right: 8px; color: var(--muted); }
  .usage-side .gauge { font-size: 11.5px; }
  @media (width > ${WEB_LAYOUT.sideWidth + WEB_LAYOUT.chatMaxWidth}px) and (hover: hover) and (pointer: fine) {
    .app { max-width: none; border: 0; grid-template-columns: max(${WEB_LAYOUT.sideWidth}px, calc((100vw - ${WEB_LAYOUT.chatMaxWidth}px) / 2)) ${WEB_LAYOUT.chatMaxWidth}px minmax(0, 1fr); grid-template-areas: "top top top" "conn conn conn" "side agents ." "side log ." "side compose ."; }
    .side { width: ${WEB_LAYOUT.sideWidth}px; justify-self: start; background: var(--bg); }
  }
  @media (min-width: ${WEB_LAYOUT.wideUsageMinWidth}px) and (hover: hover) and (pointer: fine) {
    .working-panel { right: ${WEB_LAYOUT.sideWidth}px; }
    .usage-side { display: block; position: fixed; right: 0; top: 0; bottom: 0; width: ${WEB_LAYOUT.sideWidth}px; overflow-y: auto; border-left: 1px solid var(--line); background: var(--bg); }
    .topbar, .conn { margin-right: ${WEB_LAYOUT.sideWidth}px; }
  }
  .mobile-only, .grab { display: none; }
  .code-block { min-width: 0; border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; margin: 12px 0; }
  .code-head { display: flex; justify-content: flex-end; border-bottom: 1px solid var(--line); padding-inline: 4px; background: var(--sunken); }
  .code-block pre { margin: 0; border: 0; }
  .limits-settings { display: grid; }
  .limit-row { display: grid; grid-template-columns: minmax(0, 1fr) 56px; gap: 8px; align-items: center; min-height: 44px; }
  .limit-label { min-width: 0; font-size: 12px; line-height: 1.3; }
  .limit-row input { min-width: 0; width: 56px; height: 28px; padding: 3px 6px; border: 0; border-radius: var(--r-inner); box-shadow: var(--ring); background: var(--sunken); color: var(--fg); font: 12px var(--font-mono); }
  .limit-changed { color: var(--accent); margin-left: 6px; }
  .limits-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .gui-update-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .gui-update[hidden] { display: none; }
  .limits-unlimited[aria-pressed="true"] { color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .limits-settings.unlimited .limit-row { opacity: .45; }
  .settings-sheet .sheet-panel { max-width: 480px; padding: 0 16px 16px; }
  .settings-sheet .sheet-head { position: sticky; top: 0; z-index: 1; margin: 0 -16px; padding: 8px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .settings-sheet #sheet-body { display: grid; gap: 12px; padding-top: 12px; }
  .settings-section-heading { margin: 0 0 4px 2px; color: var(--muted); font-size: 11px; font-weight: 600; }
  .settings-card { border: 1px solid var(--line); border-radius: 8px; padding: 0 12px; background: var(--panel); }
  .settings-card > .setting { margin: 0; }
  .settings-card > .setting + .setting, .settings-card > .limits-settings { border-top: 1px solid var(--line); }
  .settings-card > .setting:not(.limits-settings) { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 8px; align-items: center; min-height: 44px; padding: 2px 0; }
  .settings-card > .setting > .eyebrow { margin: 0; color: var(--fg); font-size: 12px; font-weight: 500; letter-spacing: 0; text-transform: none; }
  .settings-card > .setting > .sandbox-ready { grid-column: 1; margin: -4px 0 0; font-size: 10px; line-height: 1.2; }
  .settings-card > .limits-settings { padding: 4px 0; }
  .settings-card > .limits-settings > .eyebrow { margin: 4px 0; color: var(--fg); font-size: 12px; font-weight: 500; letter-spacing: 0; text-transform: none; }
  .settings-card .limit-row + .limit-row { border-top: 1px solid var(--line); }
  .settings-card .limits-actions { width: 100%; padding: 4px 0; border-top: 1px solid var(--line); }
  .settings-card .limits-actions .btn { min-height: 28px; border: 0; padding: 3px 7px; background: transparent; color: var(--fg-2); font-size: 11px; }
  .settings-card .limits-actions .limits-apply { background: var(--invert-bg); color: var(--invert-fg); border-radius: 4px; }
  .settings-card .limits-unlimited[aria-pressed="true"] { background: var(--sunken); box-shadow: none; color: var(--fg); }
  .settings-card > .setting.gui-update { display: block; min-height: 44px; padding: 2px 0; }
  .settings-card .gui-update-row { gap: 6px; min-height: 40px; }
  .settings-card .gui-version { margin-right: auto; }
  .settings-card .gui-update-row .btn { border: 0; background: transparent; padding: 0 4px; color: var(--fg-2); font-size: 11px; }
  .settings-sheet .seg { height: 28px; gap: 1px; padding: 1px; }
  .settings-sheet .seg button { position: relative; height: 44px; min-height: 44px; min-width: 66px; margin-top: -9px; padding: 0 7px; background: transparent; box-shadow: none; color: var(--muted); font-size: 12px; z-index: 0; }
  .settings-sheet .seg button::before { content: ""; position: absolute; inset: 9px 0; border-radius: 4px; z-index: -1; }
  .settings-sheet .seg button[aria-pressed="true"] { color: var(--fg); }
  .settings-sheet .seg button[aria-pressed="true"]::before { background: var(--panel); box-shadow: var(--ring); }
  .settings-switch { position: relative; width: 44px; height: 44px; min-height: 44px; padding: 0; border: 0; background: transparent; }
  .settings-switch::before { content: ""; position: absolute; left: 6px; top: 13px; width: 32px; height: 18px; border-radius: 999px; background: var(--line-strong); }
  .settings-switch::after { content: ""; position: absolute; left: 8px; top: 15px; width: 14px; height: 14px; border-radius: 50%; background: var(--panel); box-shadow: 0 1px 2px var(--scrim); transition: transform var(--ease); }
  .settings-switch[aria-checked="true"]::before { background: var(--accent); }
  .settings-switch[aria-checked="true"]::after { transform: translateX(14px); }
  .code-more { display: none; }
  .table-scroll { overflow-x: auto; max-width: 100%; box-shadow: inset -8px 0 8px -8px var(--muted); }
  .table-scroll table { min-width: 100%; }
  .mobile-action-label, .gauge-reset { display: none; }
  .drawer-new { display: inline-flex; align-items: center; justify-content: center; gap: 8px; color: var(--fg); background: transparent; border: 1px solid var(--line-strong); border-radius: var(--r); min-height: 44px; margin: 4px 4px 8px; }
  .sheet-backdrop:hover:not(:disabled), .sheet-backdrop:active:not(:disabled) { background: var(--scrim); transform: none; }
  @media (max-width: 899px), (pointer: coarse) {
    .mobile-only { display: flex; }
    html, body { overflow: hidden; }
    .app { position: fixed; top: var(--viewport-top, 0px); left: 0; right: 0; height: var(--viewport-height, 100dvh); grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr) auto; grid-template-areas: "top" "conn" "log" "compose"; padding-inline: env(safe-area-inset-left) env(safe-area-inset-right); }
    .topbar { height: calc(48px + env(safe-area-inset-top)); padding: env(safe-area-inset-top) 2px 0; gap: 0; flex-wrap: nowrap; }
    .topbar > .brand, .topbar > .project-pill, .topbar > #open-project, .header-tray, .side, .agent-strip { display: none; }
    .topbar > .icon-btn { width: 44px; height: 44px; flex: none; }
    .mobile-title { flex: 1; min-width: 0; display: grid; line-height: 1.25; padding: 0 4px; }
    .mobile-title b { font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mobile-title small { display: flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mobile-title small .i { width: 13px; height: 13px; flex: none; }
    #mobile-agents { flex: none; }
    .mobile-agent-skeleton { width: 48px; height: 30px; border-radius: 999px; margin: 0 2px; }
    .apill { border: 0; background: none; display: inline-grid; place-items: center; height: 44px; padding: 0 2px; border-radius: var(--r); }
    .apill .in { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 6px 0 9px; border-radius: 999px; background: var(--sunken); }
    .apill:hover .in, .apill[aria-expanded="true"] .in { background: var(--panel); box-shadow: var(--ring-strong); }
    .apill .dot { width: 8px; height: 8px; border-radius: 2px; background: var(--agent); }
    .apill[data-state="busy"] .dot { border-radius: 50%; animation: pulse 1.5s infinite; }
    .apill[data-state="starting"] .dot { background: none; border: 1px dashed var(--agent); border-radius: 50%; animation: spin 1s linear infinite; }
    .apill[data-state="stopped"] .dot { background: var(--muted); }
    .apill .shield { width: 12px; height: 12px; color: var(--warn); margin-left: -2px; }
    .ring { width: 20px; height: 20px; transform: rotate(-90deg); }
    .ring circle { fill: none; stroke-width: 2.6; }
    .ring .bg { stroke: var(--line-strong); } .ring .fg { stroke: var(--agent); stroke-linecap: round; }
    .apill[data-state="stopped"] .ring .fg { stroke: var(--muted); }
    .log { padding: 0 14px 64px; }
    .entry { grid-template-columns: 20px minmax(0, 1fr); gap: 6px 8px; padding: 14px 0; }
    .entry > :not(.mark):not(.head), .entry.question > :not(.mark):not(.head) { grid-column: 1 / -1; }
    .entry > .mark { grid-row: 1; width: 20px; height: 20px; font-size: 10px; border-radius: 5px; }
    .entry > .head { grid-column: 2; grid-row: 1; }
    .entry .head .state { margin-left: auto; font-size: 11.5px; color: var(--muted); }
    .entry .head .state.working::after { display: none; }
    .entry .body { font-size: 15px; }
    .fold > summary { min-height: 44px; padding: 8px 6px; }
    .code-head .icon-btn { width: 44px; height: 44px; }
    .code-block.long:not(.expanded) pre { max-height: 168px; overflow: hidden; mask-image: linear-gradient(#000 60%, transparent); }
    .settings-sheet .sheet-panel { padding: 0 max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
    .settings-card { padding-inline: 10px; }
    .settings-card .limit-row { grid-template-columns: minmax(0, 1fr) 56px; gap: 6px; }
    .settings-card .limits-actions .btn { min-height: 44px; }
    .code-block.long .code-more { display: flex; justify-content: center; align-items: center; gap: 6px; width: 100%; height: 44px; border: 0; border-top: 1px solid var(--line); background: var(--panel); color: var(--fg-2); }
    .code-block.expanded .code-more .i { transform: rotate(180deg); }
    .question-option { min-height: 48px; }
    input, textarea, select, .question-other, .role-editor, .model-custom { font-size: 16px !important; }
    .question-other, .question-nav button { min-height: 44px; }
    .question-dock { margin-bottom: 6px; }
    .question-dock-body { max-height: 45vh; }
    .composer { position: relative; padding: 6px 8px max(8px, env(safe-area-inset-bottom)); }
    .working-tabs { position: absolute; top: auto; left: 12px; bottom: calc(100% + 10px); right: auto; display: flex; gap: 8px; }
    .working-tab { display: inline-flex; align-items: center; gap: 7px; width: auto; height: 36px; min-width: 80px; padding: 0 13px 0 11px; border-radius: 999px; box-shadow: var(--shadow-pop); background: var(--panel); color: var(--fg); }
    .working-tab::after { content: ""; position: absolute; inset: -4px 0; }
    .working-tab .count { position: static; background: none; color: var(--muted); width: auto; height: auto; }
    #working-toggle .i { display: none; }
    #working-toggle::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--agent, var(--accent)); animation: state-pulse 1.4s infinite; }
    .mobile-tab-label { font-size: 13px; }
    .box { grid-template-columns: 44px minmax(0, 1fr) 44px 44px; align-items: end; border-radius: 16px; padding: 2px; gap: 0; }
    .box > .pending, .box > .suggest { grid-column: 1 / -1; }
    .box > .pending { grid-row: 1; } .box > .suggest { grid-row: 2; }
    .box .bar { display: contents; } .to, .target-slot, .solo-badge { display: none; }
    .shell-input .to-mark:disabled { opacity: 1; color: var(--code); }
    .shell-input .to-mark > .i { width: 26px; height: 26px; }
    .to-mark { display: inline-grid; place-items: center; grid-column: 1; grid-row: 3; width: 44px; height: 44px; border-radius: 13px; }
    .to-mark .mark { width: 26px; height: 26px; font-size: 12px; border-radius: 7px; }
    .input-wrap { grid-column: 2; grid-row: 3; }
    .box textarea, .input-highlight { font-size: 16px; min-height: 44px; max-height: 30dvh; padding: 10px 4px 10px 6px; line-height: 1.5; scrollbar-gutter: auto; }
    .box .attach { display: none; }
    .box .mobile-add { grid-column: 3; grid-row: 3; width: 44px; height: 44px; border-radius: 13px; }
    .box .send { grid-column: 4; grid-row: 3; width: 44px; height: 44px; border-radius: 13px; }
    .newer { bottom: 60px; }
    .sheet { align-items: end; }
    .sheet-panel { max-height: 80dvh; max-width: none; border-radius: 16px 16px 0 0; padding: 0 max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); animation: sheet-mobile-in 260ms cubic-bezier(.2,.7,.3,1); }
    @keyframes sheet-mobile-in { from { transform: translateY(100%); } }
    .grab { display: block; width: 100%; height: 24px; position: relative; touch-action: none; }
    .grab::before { content: ""; position: absolute; left: 50%; top: 9px; width: 36px; height: 5px; margin-left: -18px; border-radius: 3px; background: var(--line-strong); }
    .sheet-head .icon-btn { width: 44px; height: 44px; }
    .sheet button, .sheet input:not([type="checkbox"]), .sheet select { min-height: 44px; }
    .settings-sheet .limit-row input { min-height: 28px; }
    .sheet .controls .links { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
    .sheet .controls > .state { display: inline-flex; align-items: center; gap: 5px; width: fit-content; font-size: 11.5px; border-radius: 999px; padding: 2px 7px; background: var(--sunken); margin: 6px 0 12px; }
    .sheet .controls > .state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--agent); }
    .sheet .controls > .state::after { display: none; }
    .sheet .controls .links button { gap: 6px; width: auto; height: 44px; border: 1px solid var(--line); }
    .sheet .controls .links .danger { color: var(--crit); border-color: color-mix(in srgb, var(--crit) 35%, var(--line)); }
    .sheet .controls .links .danger:disabled { color: var(--muted); }
    .mobile-action-label { display: inline; font-size: 14px; }
    .sheet .mini-gauges { width: 100%; margin: 14px 0; gap: 12px; }
    .sheet.drawer { align-items: stretch; justify-items: start; }
    .sheet.drawer .sheet-panel { margin: 0; width: 86%; max-width: 380px; max-height: 100%; border-radius: 0; padding: env(safe-area-inset-top) 8px max(8px, env(safe-area-inset-bottom)); background: var(--bg); display: flex; flex-direction: column; animation: drawer-in 240ms ease-out; }
    @keyframes drawer-in { from { transform: translateX(-100%); } }
    .drawer .grab { display: none; } .drawer .sheet-head { height: 52px; padding-left: 8px; flex: none; }
    .drawer #sheet-body { display: flex; flex-direction: column; min-height: 0; flex: 1; }
    .drawer .drawer-new { flex: none; }
    .drawer-conversations { overflow-y: auto; }
    .drawer .conv-row { min-height: 56px; }
    .drawer .conv-menu { width: 44px; height: 44px; opacity: 1; }
    .drawer-projects { margin-top: auto; border-top: 1px solid var(--line); padding: 8px 4px; }
    .drawer-projects .project-pill { width: 100%; height: 44px; max-width: none; }
    .drawer-projects .project-pill select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
    .sheet .gauge-reset { display: inline; color: var(--muted); margin-right: 8px; font-weight: 400; }
    .mobile-menu-actions { display: grid; gap: 4px; }
    .mobile-menu-actions button { width: 100%; justify-content: flex-start; gap: 12px; padding: 0 12px; }
    .sheet.mobile-pop { align-items: start; justify-items: end; }
    .mobile-pop .sheet-panel { width: 240px; margin: calc(52px + env(safe-area-inset-top)) 8px 0 0; padding: 6px; border-radius: var(--r-outer); box-shadow: var(--shadow-pop); animation: sheet-in 150ms ease-out; }
    .mobile-pop .sheet-backdrop, .mobile-pop .sheet-backdrop:hover:not(:disabled), .mobile-pop .sheet-backdrop:active:not(:disabled) { background: transparent; }
    .sheet.add-pop { align-items: end; }
    .add-pop .sheet-panel { margin: 0 8px calc(70px + env(safe-area-inset-bottom)) 0; }
    .mobile-pop .grab, .mobile-pop .sheet-head { display: none; }
    .pending button { min-width: 44px; min-height: 44px; }
    .ref { min-height: 44px; }
    body.kbd .topbar { display: none; }
    body.kbd .app { grid-template-areas: "conn" "log" "compose"; grid-template-rows: auto minmax(0, 1fr) auto; }
    body.kbd .working-tabs { display: none; }
    body.kbd .composer { padding-bottom: 6px; }
  }

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
    ${button("mobile-menu", "menu", "web.top.conversations", "mobile-only")}
    <div class="mobile-title mobile-only"><b id="mobile-title"></b><small id="mobile-project"></small></div>
    <div id="mobile-agents" class="mobile-only"><span class="sk mobile-agent-skeleton"></span><span class="sk mobile-agent-skeleton"></span></div>
    ${button("mobile-more", "ellipsis", "web.top.more", "mobile-only")}
    <span class="brand">Clodex</span>
    <div class="project-pill" id="project-pill">${icon("folder")}<span id="project-name"></span>${icon("chevron-down")}<select id="projects" aria-label="${m("web.top.projects")}"></select></div>
    ${button("open-project", "folder-open", "web.top.openProject")}
    <div class="header-tray tray">
      <div class="working-tabs"><button class="icon-btn working-tab" id="working-toggle" type="button" aria-expanded="false" aria-label="${m("web.working.title")}" title="${m("web.working.title")}" hidden>${icon("activity")}<span class="count" id="working-count">0</span></button></div>
      ${button("detail", "list-tree", "web.top.detailTitle", "", 'aria-pressed="false"')}
      ${button("open-artifacts", "files", "web.top.artifacts")}
      ${button("open-conversations", "messages", "web.top.conversations")}
      ${button("cycle-theme", "monitor", "web.settings.theme")}
      ${button("open-settings", "settings", "web.top.settings")}
    </div>
  </header>
  <div class="conn" id="conn" hidden role="status"><span class="spin" id="conn-spinner"></span><span id="conn-label">${m("web.conn.lost")}</span><button class="btn" id="reload" type="button" hidden>${m("web.conn.reload")}</button></div>
  <section class="agent-strip" id="agents" aria-label="Agent"><div class="strip-well" aria-hidden="true">${[0, 1].map(() => '<div class="strip-skeleton"><span class="sk sk-avatar"></span><div class="sk-identity"><div><span class="sk sk-name"></span><span class="sk sk-state"></span></div><span class="sk sk-settings"></span></div><div class="sk-gauges"><span class="sk"></span><span class="sk"></span><span class="sk"></span></div></div>').join("")}</div></section>
  <aside class="side">
    <section>
      <div class="side-head"><div class="eyebrow">${m("web.side.conversations")}</div>${button("new-conversation", "square-pen", "web.side.newConversation")}</div>
      <div id="conversations">${[0, 1, 2].map(() => '<div class="conv-skeleton" aria-hidden="true"><span class="sk"></span><span class="sk"></span></div>').join("")}</div>
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
    <section class="question-dock" id="question-dock" aria-label="${m("web.question.title")}" hidden></section>
    <div class="upload-status" id="upload-status" role="status" hidden><span class="spin"></span>${m("web.upload.loading")}</div>
    <div class="box">
      <ul class="pending" id="pending" aria-label="${m("web.pending.label")}" hidden></ul>
      <ul class="suggest" id="suggest" role="listbox" aria-label="${m("web.suggest.label")}" hidden></ul>
      ${button("target-toggle", "refresh", "web.to.label", "mobile-only to-mark")}
      <div class="input-wrap">
        <div class="input-highlight" id="input-highlight" aria-hidden="true"></div>
        <textarea id="input" rows="1" aria-label="${m("web.input.label")}" enterkeyhint="enter" role="combobox" aria-controls="suggest" aria-expanded="false" aria-autocomplete="list"></textarea>
      </div>
      <div class="bar">
        <div class="target-slot"><div class="to" role="group" aria-label="${m("web.to.label")}">
          <button type="button" data-agent="claude" aria-pressed="true">Claude</button>
          <button type="button" data-agent="codex" aria-pressed="false">Codex</button>
        </div>
        <div class="shell-badge"><span>${m("web.shellInput")}</span></div></div>
        <span class="solo-badge" id="solo-badge" hidden>${m("shell.solo")}</span>
        ${button("attach", "image-plus", "web.attach.label", "attach")}
        ${button("mobile-add", "plus", "web.mobile.add", "mobile-only mobile-add")}
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
    <div class="grab" id="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="sheet-title"></h2>${button("sheet-close", "x", "web.sheet.close", "sheet-close")}</div>
    <div id="sheet-body"></div>
  </div>
</div>
<div class="lightbox" id="lightbox" hidden role="dialog" aria-modal="true" aria-label="${m("web.image.title")}">
  <div class="lb-bar">
    <span class="lb-name" id="lb-name"></span>
    <div class="lb-tools">
      ${button("lb-zoom-out", "zoom-out", "web.image.zoomOut")}
      <button class="lb-scale" id="lb-scale" type="button" aria-label="${m("web.image.actual")}" title="${m("web.image.actual")}">100%</button>
      ${button("lb-zoom-in", "zoom-in", "web.image.zoomIn")}
      ${button("lb-fit", "maximize", "web.image.fit")}
      <a class="icon-btn" id="lb-open" target="_blank" rel="noopener noreferrer" aria-label="${m("web.image.open")}" title="${m("web.image.open")}">${icon("external-link")}</a>
      ${button("lb-close", "x", "web.sheet.close")}
    </div>
  </div>
  <div class="lb-stage" id="lb-stage"><img id="lb-image" alt="" draggable="false"></div>
</div>
<aside class="usage-side" id="usage-side" aria-label="${m("web.usage.title")}"></aside>
<div class="usage-popover" id="usage-popover" role="dialog" aria-label="${m("web.usage.title")}" hidden></div>
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
  workingFeed: ${inlineScript(workingFeed.toString())},
  nextUnanswered: ${inlineScript(nextUnanswered.toString())},
  questionAnswers: ${inlineScript(questionAnswers.toString())},
  withStartingTurns: ${inlineScript(withStartingTurns.toString())},
  resolvePendingSettings: ${inlineScript(resolvePendingSettings.toString())},
  isNavigationCommand: ${inlineScript(isNavigationCommand.toString())},
  nextCommandStarts: ${inlineScript(nextCommandStarts.toString())},
  composeInputLine: ${inlineScript(composeInputLine.toString())},
  isSendKey: ${inlineScript(isSendKey.toString())},
  settingsSections: ${inlineScript(settingsSections.toString())},
  limitChanges: ${inlineScript(limitChanges.toString())},
  fitView: ${inlineScript(fitView.toString())},
  zoomView: ${inlineScript(zoomView.toString())},
  createInputAssist: ${inlineScript(createInputAssist.toString())},
  collectArtifacts: ${inlineScript(collectArtifacts.toString())},
  findImagePaths: ${inlineScript(findImagePaths.toString())},
  splitImagePaths: ${inlineScript(splitImagePaths.toString())},
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
  layout: ${json(WEB_LAYOUT)},
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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
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
