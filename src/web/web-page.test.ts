import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { applyFeedItem, rebuildTimeline } from "./client/timeline.js";
import { renderMarkdown } from "./client/markdown.js";
import { buildWebPage, ICON_SVG, MANIFEST } from "./web-page.js";
import { ja } from "../i18n/messages.js";

const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");

describe("buildWebPage", () => {
  it("広い画面の利用状況領域と共通の寸法を埋め込む", () => {
    const html = buildWebPage("ja").html;
    expect(html).toContain('id="usage-side"');
    expect(html).toContain('"wideUsageMinWidth":1700');
    expect(html).toContain('width > 1360px');
    expect(html).toContain('min-width: 1700px');
  });
  it("コマンド印を送り先と同じ場所に置き、利用状況のパネルを持つ", () => {
    const html = buildWebPage("ja").html;
    expect(html).not.toContain('id="shell-input-label"');
    expect(html).toContain('class="target-slot"');
    expect(html).toContain('class="shell-badge"');
    expect(html).toContain('id="usage-popover"');
    expect(html).toContain('aria-label="利用状況"');
    expect(html).not.toMatch(/el\("button", "(?:strip-summary|setting-chip mono)"/);
  });
  it("入力欄の外側の薄い縁を、入力欄で送り先の色から作る", () => {
    const html = buildWebPage("ja").html;
    expect(html).toContain(".box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }");
    expect(html).not.toContain("--accent-soft");
  });
  it("GUI と同じ図形のアイコンを使う", () => {
    const guiIcon = readFileSync(new URL("../../gui/icon.svg", import.meta.url), "utf8");
    expect(ICON_SVG.trim()).toBe(guiIcon.trim());
    expect(ICON_SVG).not.toContain("<text");
  });

  it("黒背景と iPhone 用アイコンを指定する", () => {
    const { html } = buildWebPage("ja");
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(html).toContain('<meta name="theme-color" content="#000000">');
    expect(JSON.parse(MANIFEST)).toMatchObject({ background_color: "#000000", theme_color: "#000000" });
  });

  it("通知の状態遷移は画面に埋め込まない", () => {
    expect(buildWebPage("ja").html).not.toContain("updateDesktopNotify:");
  });
  it("会話ごとの下書き関数を外部依存なく埋め込む", () => {
    const script = scriptsOf(buildWebPage("ja").html)[1]!;
    const deps = script.slice(script.lastIndexOf("draftKey:"), script.lastIndexOf("isSendKey:"));
    const embedded = runInNewContext(`({${deps}})`) as {
      draftKey: (projectRoot: string, conversationId: string) => string;
      staleDraftKeys: (keys: string[], projectRoot: string, conversationIds: string[]) => string[];
    };
    const kept = embedded.draftKey("C:\\work", "a");
    const stale = embedded.draftKey("C:\\work", "b");
    expect(embedded.staleDraftKeys([kept, stale], "C:\\work", ["a"])).toEqual([stale]);
  });
  it("画像パス抽出を自己完結した関数として埋め込み、会話本文にプレビューを付ける", () => {
    const { html } = buildWebPage("ja");
    const script = scriptsOf(html)[1]!;
    const deps = script.slice(script.lastIndexOf("findImagePaths:"), script.lastIndexOf("displayPath:"));
    const findPaths = runInNewContext(`({${deps}}).findImagePaths`) as (text: string) => string[];
    expect(findPaths("C:\\out\\shot.png c:/OUT/shot.PNG")).toEqual(["C:\\out\\shot.png"]);
    expect(html).toContain('appendImagePreviews(node, [item.plan, item.text].filter(Boolean).join("\\n"), item.at)');
    expect(html).toContain("appendImagePreviews(node, item.text, item.at)");
    expect(html).toContain("appendImagePreviews(node, message.body, item.at)");
    expect(html).toContain("appendImagePreviews(node, previewText, item.at)");
    expect(html).toContain("appendImagePreviews(field, [question.question, ...question.options.map");
    expect(html).not.toContain("appendImagePreviews(node, step.text)");
    expect(html).toContain('image.loading = "lazy"');
    expect(html).toContain('image.src = fileUrl("file", path, version)');
    expect(html).toContain("unlinkImagePath(node, path)");
    expect(html).toContain("linkImagePaths(node, version);");
    expect(html).toContain("link.title = part.path;");
    expect(html).toMatch(/\.image-link\s*\{[^}]*cursor:\s*zoom-in/);
    expect(html).toContain(".md a, .image-link { color: var(--link); text-decoration: underline;");
    const split = runInNewContext(`({${deps}}).splitImagePaths`) as (text: string) => Array<{ text: string; path?: string }>;
    expect(split("見て C:/out/a.png")).toEqual([{ text: "見て " }, { text: "C:/out/a.png", path: "C:/out/a.png" }]);
    expect(html).toMatch(/\.image-previews\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(html).toMatch(/\.image-preview img\s*\{[^}]*max-height:\s*96px;\s*max-width:\s*160px/);
  });
  it("画像は全画面のビューアで開き、拡大縮小の計算を自己完結した関数として埋め込む", () => {
    const { html } = buildWebPage("ja");
    expect(html).toContain('id="lightbox"');
    expect(html).toContain('aria-label="拡大"');
    expect(html).toContain('aria-label="新しいタブで開く"');
    expect(html).toContain('button.addEventListener("click", () => openImage(path, version))');
    const script = scriptsOf(html)[1]!;
    const deps = script.slice(script.lastIndexOf("fitView:"), script.lastIndexOf("createInputAssist:"));
    const { fitView, zoomView } = runInNewContext(`({${deps}})`) as { fitView: (a: object, b: object) => { scale: number }; zoomView: (v: object, f: number, p: object) => { scale: number } };
    expect(fitView({ width: 2000, height: 1000 }, { width: 1000, height: 1000 }).scale).toBe(0.5);
    expect(zoomView({ scale: 1, x: 0, y: 0 }, 2, { x: 0, y: 0 }).scale).toBe(2);
  });

  it("作業ログは発言を時系列に並べる関数を埋め込んで描く", () => {
    const { html } = buildWebPage("ja");
    const script = scriptsOf(html)[1]!;
    const deps = script.slice(script.lastIndexOf("workingFeed:"), script.lastIndexOf("withStartingTurns:"));
    expect(runInNewContext(`({${deps}}).workingFeed`)([])).toEqual([]);
    expect(html).toContain("const feed = workingFeed(items);");
    expect(html).toContain('el("div", "working-say md")');
    expect(html).not.toContain("working-entry");
  });

  it("Push を使える画面だけ設定に通知の節を出し、購読した端末は見えているかを Hub に知らせる", () => {
    const { html } = buildWebPage("ja");
    expect(html).toContain('const pushSupported = "serviceWorker" in navigator && "PushManager" in window && !tauriApi;');
    expect(html).toContain('applicationServerKey: base64Bytes(key)');
    expect(html).toContain('query.set("push", pushId)');
    expect(html).toContain('postJson("/api/push/visibility"');
  });

  it("割り込みが届いたらチェックマークのアイコンを出し、文言は title に持たせる", () => {
    const { html } = buildWebPage("ja");
    expect(html).toContain('const delivered = el("span", "steer-delivered");');
    expect(html).toContain('delivered.append(icon("check"));');
    expect(html).not.toContain("steer-state");
  });

  it("未回答の質問は入力欄の上の質問欄に 1 問ずつ出し、件数の pill は出さない", () => {
    const { html } = buildWebPage("ja");
    const composer = html.slice(html.indexOf('<form class="composer"'), html.indexOf('<div class="box">'));
    expect(composer).toContain('id="question-dock"');
    expect(html).not.toContain("question-toggle");
    const script = scriptsOf(html)[1]!;
    const deps = script.slice(script.lastIndexOf("nextUnanswered:"), script.lastIndexOf("withStartingTurns:"));
    const { nextUnanswered } = runInNewContext(`({${deps}})`) as { nextUnanswered: (q: object[], d: object, c: number) => number | undefined };
    expect(nextUnanswered([{ options: [] }, { options: [] }], { selected: [new Set([0]), new Set()], other: ["", ""] }, 0)).toBe(1);
    expect(html).toContain("if (!question.multiSelect && !wasSelected) return advance();");
    expect(html).toMatch(/\.question-dock-body\s*\{[^}]*max-height:\s*50vh;\s*overflow-y:\s*auto/);
  });

  it("GUI の中の画面は GUI の版を添えてつなぎ、更新の依頼を Tauri の command で行う", () => {
    const { html } = buildWebPage("ja");
    expect(html).toContain('if (guiVersion) query.set("gui", guiVersion);');
    expect(html).toContain('invoke("install_update")');
    expect(html).toContain('invoke("check_update")');
    expect(html).toContain('postJson("/api/gui/update", { action })');
    expect(html).toContain(".gui-update[hidden] { display: none; }");
  });

  it("コマンド入力の色・ラベル・切り替え処理をページに含める", () => {
    const { html } = buildWebPage("ja");
    expect(html).not.toContain('id="shell-input-label"');
    expect(html).toContain("<span>コマンド</span>");
    expect(html).toContain('.classList.toggle("shell-input", shell)');
    expect(html).toContain("const disabled = shell || Boolean(solo && solo !== \"free\")");
    expect(html).toContain('.shell-input .box { border-color: var(--code)');
    expect(html).toContain('.shell-input .box .input-highlight, .shell-input .box textarea { font-family: var(--font-mono)');
    expect(buildWebPage("en").html).toContain("<span>Command</span>");
  });
  it("project の選択と新規オープンを画面上部に表示する", () => {
    const { html } = buildWebPage("ja");
    expect(html).toContain('<select id="projects" aria-label="プロジェクト">');
    expect(html).toMatch(/id="open-project"[^>]*aria-label="開く"[^>]*title="開く"/);
  });
  it("埋め込んだ script が構文として正しい（実行はしない）", () => {
    for (const language of ["ja", "en"] as const) {
      const scripts = scriptsOf(buildWebPage(language).html);
      expect(scripts).toHaveLength(2);
      for (const script of scripts) expect(() => new Function(script)).not.toThrow();
    }
  });

  it("UMD を読み込んだブラウザでも同じ Markdown renderer が動く", () => {
    const [umd] = scriptsOf(buildWebPage("ja").html);
    const rendered = runInNewContext(`${umd}\n(${renderMarkdown.toString()})("> 引用\\n\\n| A | B |\\n|---|---|\\n| 1 | 2 |")`);
    expect(rendered).toContain("<blockquote>");
    expect(rendered).toContain("<table>");
  });

  it("画面の版を埋め込み、言語ごとに版が変わる", () => {
    const ja = buildWebPage("ja");
    expect(ja.version).toMatch(/^[0-9a-f]{12}$/);
    expect(ja.html).toContain(`version: "${ja.version}"`);
    expect(buildWebPage("en").version).not.toBe(ja.version);
  });

  it("言語の文言で画面を作る", () => {
    expect(buildWebPage("ja").html).toContain('aria-label="送信" title="送信"');
    expect(buildWebPage("en").html).toContain('aria-label="Send" title="Send"');
    expect(buildWebPage("en").html).toContain('<html lang="en">');
  });

  it("画面の振る舞いに必要な要素がそろっている", () => {
    const { html } = buildWebPage("ja");
    for (const id of ["log", "newer", "input", "input-highlight", "suggest", "pending", "open-artifacts", "attach", "attach-file", "composer", "mobile-agents", "agents", "conversations", "sheet", "conn", "toast", "detail"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("スマホの操作口とシートのつまみを持ち、画面の拡大を制限しない", () => {
    const html = buildWebPage("ja").html;
    expect(html).not.toContain("maximum-scale");
    for (const id of ["mobile-menu", "mobile-more", "mobile-title", "target-toggle", "sheet-grab"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('id="status"');
  });

  it("操作アイコンに名前を付け、Agent ストリップを会話一覧の外に置く", () => {
    const html = buildWebPage("ja").html;
    const body = html.slice(html.indexOf("<body>"), html.indexOf("<script>"));
    const buttons = [...body.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    const icons = buttons.filter(([, , content]) => content?.includes("<use"));
    expect(icons.length).toBeGreaterThan(8);
    for (const [, attributes] of icons) {
      expect(attributes).toMatch(/aria-label="[^"]+"/);
      expect(attributes).toMatch(/title="[^"]+"/);
    }
    expect(body.match(/<symbol id="i-folder"/g)).toHaveLength(1);
    expect(body).toMatch(/<section class="agent-strip" id="agents"/);
    expect(body.match(/<aside class="side">([\s\S]*?)<\/aside>/)?.[1]).not.toContain('id="agents"');
    expect(body).not.toContain('id="path"');
  });

  it("初回の Agent と会話の skeleton に情報の形を持たせる", () => {
    const html = buildWebPage("ja").html;
    const body = html.slice(html.indexOf("<body>"), html.indexOf("<script>"));
    expect(body.match(/class="strip-skeleton"/g)).toHaveLength(2);
    expect(body.match(/class="conv-skeleton"/g)).toHaveLength(3);
    expect(body).toContain('class="sk sk-state"');
  });

  it("PC ではシートを画面中央のモーダルとして表示する", () => {
    const { html } = buildWebPage("ja");
    const desktopCss = html.split("@media (min-width: 900px) and (hover: hover) and (pointer: fine)")[1]
      ?.split("@media (max-width: 899px), (pointer: coarse)")[0];
    expect(desktopCss).toBeDefined();
    expect(desktopCss).toMatch(/\.sheet\s*\{[^}]*align-items:\s*center;[^}]*justify-items:\s*center;/);
    expect(desktopCss).toMatch(/\.sheet-panel\s*\{[^}]*border-radius:\s*14px;[^}]*max-height:\s*85vh;/);
    expect(desktopCss).toMatch(/\.sheet-panel\.wide\s*\{[^}]*max-width:\s*960px;/);
  });
});

it("履歴の再構築をブラウザで呼べる関数として埋め込む", () => {
  const script = scriptsOf(buildWebPage("ja").html)[1]!;
  const source = script.slice(script.lastIndexOf("rebuildTimeline:"), script.lastIndexOf("composeInputLine:"));
  const rebuild = runInNewContext(`({${source}}).rebuildTimeline`) as typeof rebuildTimeline;
  expect(rebuild([{ type: "output", seq: 1, text: "過去" }], applyFeedItem)).toEqual([{ kind: "output", id: "o1", text: "過去" }]);
});
