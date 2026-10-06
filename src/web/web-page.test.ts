import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { renderMarkdown } from "./client/markdown.js";
import { buildWebPage } from "./web-page.js";

const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");

describe("buildWebPage", () => {
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
