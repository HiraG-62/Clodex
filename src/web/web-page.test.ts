import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { applyFeedItem, rebuildTimeline } from "./client/timeline.js";
import { renderMarkdown } from "./client/markdown.js";
import { buildWebPage, ICON_SVG, MANIFEST } from "./web-page.js";
import type { updateDesktopNotify } from "./client/desktop-notify.js";
import { ja } from "../i18n/messages.js";

const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");

describe("buildWebPage", () => {
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

  it("通知の状態遷移を外部依存のない関数として埋め込む", () => {
    const script = scriptsOf(buildWebPage("ja").html)[1]!;
    const deps = script.slice(script.lastIndexOf("updateDesktopNotify:"), script.lastIndexOf("commands:"));
    const update = runInNewContext(`({${deps}}).updateDesktopNotify`) as typeof updateDesktopNotify;
    expect(update({ live: true, working: false }, { type: "event", seq: 1, event: { kind: "notice", text: "通知", at: "now" } }, ja).notification?.body).toBe("通知");
  });
  it("画像パス抽出を自己完結した関数として埋め込み、会話本文にプレビューを付ける", () => {
    const { html } = buildWebPage("ja");
    const script = scriptsOf(html)[1]!;
    const deps = script.slice(script.lastIndexOf("findImagePaths:"), script.lastIndexOf("displayPath:"));
    const findPaths = runInNewContext(`({${deps}}).findImagePaths`) as (text: string) => string[];
    expect(findPaths("C:\\out\\shot.png c:/OUT/shot.PNG")).toEqual(["C:\\out\\shot.png"]);
    expect(html.match(/appendImagePreviews\(node, item.text\)/g)).toHaveLength(2);
    expect(html).toContain("appendImagePreviews(node, message.body)");
    expect(html).not.toContain("appendImagePreviews(node, item.plan)");
    expect(html).not.toContain("appendImagePreviews(node, step.text)");
    expect(html).toContain('image.loading = "lazy"');
    expect(html).toContain('image.src = fileUrl("file", path)');
    expect(html).toContain('image.addEventListener("error", () => button.remove())');
    expect(html).toMatch(/\.image-previews\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(html).toMatch(/\.image-preview img\s*\{[^}]*max-height:\s*160px/);
  });

  it("コマンド入力の色・ラベル・切り替え処理をページに含める", () => {
    const { html } = buildWebPage("ja");
    expect(html).toContain('id="shell-input-label" hidden');
    expect(html).toContain('id="shell-input-label" hidden>コマンド</div>');
    expect(html).toContain('.classList.toggle("shell-input", shell)');
    expect(html).toContain("button.disabled = shell");
    expect(html).toContain('.shell-input .box { border-color: var(--code)');
    expect(html).toContain('.shell-input .box .input-highlight, .shell-input .box textarea { font-family: var(--font-mono)');
    expect(buildWebPage("en").html).toContain('id="shell-input-label" hidden>Command</div>');
  });
  it("project の選択と新規オープンを画面上部に表示する", () => {
    const { html } = buildWebPage("ja");
    expect(html).toContain('<select id="projects" aria-label="プロジェクト">');
    expect(html).toContain('id="open-project">開く</button>');
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
    expect(buildWebPage("ja").html).toContain(">送信</button>");
    expect(buildWebPage("en").html).toContain(">Send</button>");
    expect(buildWebPage("en").html).toContain('<html lang="en">');
  });

  it("画面の振る舞いに必要な要素がそろっている", () => {
    const { html } = buildWebPage("ja");
    for (const id of ["log", "newer", "input", "input-highlight", "suggest", "pending", "open-artifacts", "attach", "attach-file", "composer", "status", "agents", "conversations", "sheet", "conn", "toast", "detail"]) {
      expect(html).toContain(`id="${id}"`);
    }
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
