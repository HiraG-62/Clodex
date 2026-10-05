import { describe, expect, it } from "vitest";
import { buildWebPage } from "./web-page.js";

describe("buildWebPage", () => {
  it("埋め込んだ script が構文として正しい（実行はしない）", () => {
    for (const language of ["ja", "en"] as const) {
      const script = buildWebPage(language).html.match(/<script>([\s\S]*)<\/script>/)?.[1];
      expect(script).toBeDefined();
      expect(() => new Function(script!)).not.toThrow();
    }
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
    for (const id of ["log", "newer", "input", "input-highlight", "suggest", "pending", "open-artifacts", "composer", "status", "agents", "conversations", "sheet", "conn", "toast", "detail"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
