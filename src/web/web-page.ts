// Web UI の画面（DESIGN.md §17 Web UI）。HTML 1 枚に CSS と JS を inline で持つ。
// 画面の振る舞いは src/web/client/ に型付きで書き、関数のソースをそのまま埋め込む
import { createHash } from "node:crypto";
import { slashCommands } from "../cli/commands.js";
import type { Language } from "../context/language.js";
import { MESSAGES } from "../i18n/i18n.js";
import type { MessageKey, Messages } from "../i18n/messages.js";
import { clientMain } from "./client/client-main.js";
import { createInputAssist } from "./client/input-assist.js";
import { collectArtifacts, displayPath } from "./client/artifacts.js";
import { renderMarkdown } from "./client/markdown.js";
import { applyFeedItem } from "./client/timeline.js";
import { composeInputLine } from "./client/compose-input.js";

const STYLE = `
  :root {
    --bg: #fafafa; --panel: #ffffff; --sunken: #f2f2f3; --line: #e6e6e8; --line-strong: #d4d4d8;
    --fg: #111113; --fg-2: #3f3f46; --muted: #80808a;
    --claude: #b4793f; --codex: #4b6fa5;
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
  .agent .role { margin-left: 30px; }
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
  .model-form input { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font: 14px var(--font-mono); background: var(--panel); color: var(--fg); }
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
  .entry.you .body { color: var(--fg); font-weight: 500; }
  .md > * { margin: 0 0 8px; } .md > *:last-child { margin-bottom: 0; }
  .md .md-h { font-weight: 600; color: var(--fg); }
  .md ul, .md ol { padding-left: 1.3em; }
  .md pre { padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; font: 12.5px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--sunken); }
  .md pre code { padding: 0; background: none; }
  code { font-family: var(--font-mono); font-size: .92em; padding: 1px 5px; border-radius: 4px; background: var(--sunken); color: var(--fg); overflow-wrap: anywhere; }

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
  .input-wrap { display: grid; }
  .input-wrap > * { grid-area: 1 / 1; }
  /* textarea の背後に同じ折り返しで描き、指定した語の背景だけを見せる */
  .input-highlight, .box textarea { padding: 12px 14px 4px; font: inherit; font-size: 16px; white-space: pre-wrap; overflow-wrap: anywhere; scrollbar-gutter: stable; }
  .input-highlight { color: transparent; pointer-events: none; overflow: hidden; }
  .input-highlight mark { color: transparent; border-radius: 3px; }
  .input-highlight .hl-command { background: color-mix(in srgb, var(--fg) 14%, transparent); }
  .input-highlight .hl-claude { background: color-mix(in srgb, var(--claude) 26%, transparent); }
  .input-highlight .hl-codex { background: color-mix(in srgb, var(--codex) 26%, transparent); }
  .input-highlight .hl-file { background: color-mix(in srgb, var(--warn) 24%, transparent); }
  .box textarea { position: relative; border: 0; background: transparent; resize: none; color: var(--fg);
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
  .box textarea::placeholder { color: var(--muted); }
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
  .toast { position: fixed; left: 50%; bottom: calc(96px + env(safe-area-inset-bottom)); transform: translateX(-50%); max-width: calc(100% - 32px);
    padding: 8px 14px; border-radius: 8px; background: var(--invert-bg); color: var(--invert-fg); font-size: 13px; z-index: 30; }

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

  .app { display: grid; height: 100%; max-width: 1240px; margin: 0 auto; min-width: 0;
    grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto minmax(0, 1fr) auto;
    grid-template-areas: "top" "conn" "status" "log" "compose"; }
  .topbar { grid-area: top; } .conn { grid-area: conn; } .status { grid-area: status; } .log-wrap { grid-area: log; } .composer { grid-area: compose; }
  @media (min-width: 900px) and (hover: hover) and (pointer: fine) {
    .app { grid-template-columns: 300px minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr) auto;
      grid-template-areas: "top top" "conn conn" "side log" "side compose"; border-inline: 1px solid var(--line); }
    .side { grid-area: side; display: flex; border-right: 1px solid var(--line); overflow-y: auto; }
    .status { display: none; }
    .log { padding-inline: 32px; } .composer { padding-inline: 32px; }
    #open-conversations { display: none; }
  }
`;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const body = (messages: Messages) => {
  const m = (key: MessageKey) => escapeHtml(messages[key]);
  return `
<div class="app">
  <header class="topbar">
    <span class="brand">Clodex</span>
    <select id="projects" aria-label="${m("web.top.projects")}"></select>
    <button class="ghost" type="button" id="open-project">${m("web.top.openProject")}</button>
    <span class="path mono" id="path"></span>
    <button class="ghost" type="button" id="detail" aria-pressed="false" title="${m("web.top.detailTitle")}">${m("web.top.detail")}</button>
    <button class="ghost" type="button" id="open-artifacts">${m("web.top.artifacts")}</button>
    <button class="ghost" type="button" id="open-conversations">${m("web.top.conversations")}</button>
    <button class="ghost" type="button" id="open-settings">${m("web.top.settings")}</button>
  </header>
  <div class="conn" id="conn" hidden role="status">${m("web.conn.lost")}</div>
  <div class="status" id="status"></div>
  <aside class="side">
    <div id="agents" style="display:grid;gap:28px"></div>
    <section>
      <div class="side-head"><div class="eyebrow">${m("web.side.conversations")}</div><button class="ghost small" type="button" id="new-conversation">${m("web.side.newConversation")}</button></div>
      <div id="conversations"></div>
    </section>
  </aside>
  <div class="log-wrap">
    <main class="log" id="log" aria-label="${m("web.log.label")}" aria-live="polite">
      <div class="empty" id="empty"><b>${m("web.empty.title")}</b>${m("web.empty.body")}</div>
    </main>
    <button class="newer" type="button" id="newer" hidden>${m("web.newer")}</button>
  </div>
  <form class="composer" id="composer">
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
        <button class="attach" type="button" id="attach" title="${m("web.attach.label")}">${m("web.attach")}</button>
        <input type="file" id="attach-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
        <button class="send" type="submit">${m("web.send")}</button>
      </div>
    </div>
  </form>
</div>
<div class="sheet" id="sheet" hidden>
  <button class="sheet-backdrop" id="sheet-backdrop" type="button" aria-label="${m("web.sheet.close")}"></button>
  <div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <div class="sheet-head"><h2 id="sheet-title"></h2><button class="sheet-close" id="sheet-close" type="button">${m("web.sheet.close")}</button></div>
    <div id="sheet-body"></div>
  </div>
</div>
<div class="toast" id="toast" hidden role="status"></div>
`;
};

// 関数のソースに </script> が含まれていても script 要素が途中で閉じないようにする
const inlineScript = (source: string) => source.replace(/<\/script/gi, "<\\/script");

const PAGE_VERSION_LENGTH = 12;
const CLIENT_SOURCE = inlineScript(clientMain.toString());
const FUNCTIONS = `
  renderMarkdown: ${inlineScript(renderMarkdown.toString())},
  applyFeedItem: ${inlineScript(applyFeedItem.toString())},
  composeInputLine: ${inlineScript(composeInputLine.toString())},
  createInputAssist: ${inlineScript(createInputAssist.toString())},
  collectArtifacts: ${inlineScript(collectArtifacts.toString())},
  displayPath: ${inlineScript(displayPath.toString())},`;
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

// ホーム画面に置けるようにする（DESIGN.md §28 D: PWA）
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#111"/><text x="256" y="330" font-family="Arial, sans-serif" font-size="260" font-weight="700" text-anchor="middle" fill="#fff">C</text></svg>`;
export const MANIFEST = JSON.stringify({
  name: "Clodex", short_name: "Clodex", start_url: "/", display: "standalone",
  background_color: "#111111", theme_color: "#111111",
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
  const version = createHash("sha256").update(STYLE).update(html).update(CLIENT_SOURCE).update(deps)
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
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<meta name="theme-color" content="#111111">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap">
<style>${STYLE}</style>
</head>
<body>
${html}
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
