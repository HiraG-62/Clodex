// Web UI の画面（DESIGN.md §17 Web UI）。HTML 1 枚に CSS と JS を inline で持つ。
import { createHash } from "node:crypto";
import { slashCommands } from "../cli/commands.js";
import type { Language } from "../context/language.js";
import { MESSAGES } from "../i18n/i18n.js";
import type { MessageKey, Messages } from "../i18n/messages.js";
import { loadClientAssets } from "./client-bundle.js";
import { loadFontCss } from "./fonts.js";
import { WEB_LAYOUT } from "./layout.js";
import { UI_ICONS } from "./web-icons.js";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

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
      ${button("open-shared", "paperclip", "web.top.shared")}
      ${button("open-artifacts", "files", "web.top.artifacts")}
      ${button("open-conversations", "messages", "web.top.conversations")}
      ${button("cycle-theme", "monitor", "web.settings.theme")}
      ${button("open-settings", "settings", "web.top.settings")}
    </div>
  </header>
  <nav class="conversation-tabs" id="conversation-tabs" aria-label="${m("web.side.conversations")}" hidden></nav>
  <div class="conn" id="conn" hidden role="status"><span class="spin" id="conn-spinner"></span><span id="conn-label">${m("web.conn.lost")}</span><button class="btn" id="reload" type="button" hidden>${m("web.conn.reload")}</button></div>
  <section class="agent-strip" id="agents" aria-label="${m("web.agents.label")}"><div class="strip-well" aria-hidden="true">${[0, 1].map(() => '<div class="strip-skeleton"><span class="sk sk-avatar"></span><div class="sk-identity"><div><span class="sk sk-name"></span><span class="sk sk-state"></span></div><span class="sk sk-settings"></span></div><div class="sk-gauges"><span class="sk"></span><span class="sk"></span><span class="sk"></span></div></div>').join("")}</div></section>
  <aside class="side">
    <section>
      <div class="side-head"><div class="eyebrow">${m("web.side.conversations")}</div>${button("new-conversation", "square-pen", "web.side.newConversation")}</div>
      <div id="conversations">${[0, 1, 2].map(() => '<div class="conv-skeleton" aria-hidden="true"><span class="sk"></span><span class="sk"></span></div>').join("")}</div>
    </section>
  </aside>
  <div class="log-wrap">
    <main class="log" id="log" aria-label="${m("web.log.label")}">
      <div class="history-loading" id="history-loading" hidden role="status"><span class="spin"></span>${m("web.history.loading")}</div>
      <div class="log-skeleton" id="log-skeleton" aria-hidden="true">${[0, 1, 2, 3].map(() => '<div class="sk-row"><span class="sk sk-avatar"></span><div class="sk-lines"><span class="sk"></span><span class="sk"></span><span class="sk"></span></div></div>').join("")}</div>
      <div class="empty" id="empty" hidden><b>${m("web.empty.title")}</b></div>
    </main>
    <div class="visually-hidden" id="announcements" aria-live="polite"></div>
    <button class="newer" type="button" id="newer" aria-label="${m("web.newer")}" title="${m("web.newer")}" hidden>${icon("arrow-down")}</button>
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

const PAGE_VERSION_LENGTH = 12;
const layoutStyle = `
:root { --side-width: ${WEB_LAYOUT.sideWidth}px; --chat-max-width: ${WEB_LAYOUT.chatMaxWidth}px; }
@media (width > ${WEB_LAYOUT.sideWidth + WEB_LAYOUT.chatMaxWidth}px) and (hover: hover) and (pointer: fine) {
  .app { max-width: none; border: 0; grid-template-columns: max(var(--side-width), calc((100vw - var(--chat-max-width)) / 2)) var(--chat-max-width) minmax(0, 1fr); grid-template-areas: "top top top" "side tabs ." "side conn ." "side agents ." "side log ." "side compose ."; }
  .side { width: var(--side-width); justify-self: start; background: var(--bg); }
}
@media (min-width: ${WEB_LAYOUT.wideUsageMinWidth}px) and (hover: hover) and (pointer: fine) {
  .working-panel { right: var(--side-width); }
  .usage-side { display: block; position: fixed; right: 0; top: 0; bottom: 0; width: var(--side-width); overflow-y: auto; border-left: 1px solid var(--line); background: var(--bg); }
  .topbar, .conn { margin-right: var(--side-width); }
}`;
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

// ホーム画面に置けるようにする（DESIGN.md §28 D: PWA）
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="100" fill="#000000"/><g fill="#DEA161"><path d="M118 144 199 225Q207 233 207 245V267Q207 279 199 287L118 368Q105 381 92 368L73 349Q60 336 73 323L132 264Q140 256 132 248L73 189Q60 176 73 163L92 144Q105 131 118 144Z"/><rect x="226" y="227" width="60" height="60" rx="12"/></g><path d="M118 144 199 225Q207 233 207 245V267Q207 279 199 287L118 368Q105 381 92 368L73 349Q60 336 73 323L132 264Q140 256 132 248L73 189Q60 176 73 163L92 144Q105 131 118 144Z" transform="translate(512 0) scale(-1 1)" fill="#7CA2DD"/></svg>`;
export const MANIFEST = JSON.stringify({
  name: "Clodex",
  short_name: "Clodex",
  start_url: "/",
  display: "standalone",
  background_color: "#000000",
  theme_color: "#000000",
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
  const { script, style } = loadClientAssets();
  const fontCss = loadFontCss();
  const config = { layout: WEB_LAYOUT, commands: slashCommands(), messages };
  const version = createHash("sha256")
    .update(fontCss)
    .update(style)
    .update(layoutStyle)
    .update(html)
    .update(script)
    .update(json(config))
    .digest("hex")
    .slice(0, PAGE_VERSION_LENGTH);
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
<style>${fontCss}\n${style}\n${layoutStyle}</style>
</head>
<body>
${html}
<script type="application/json" id="clodex-config">${json({ ...config, version })}</script>
<script>${inlineScript(script)}</script>
</body>
</html>
`,
  };
};
