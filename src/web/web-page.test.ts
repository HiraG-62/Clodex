import { describe, expect, it } from "vitest";
import { PAGE_VERSION, WEB_PAGE } from "./web-page.js";

describe("WEB_PAGE", () => {
  it("埋め込んだ script が構文として正しい（実行はしない）", () => {
    const script = WEB_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("画面の版を埋め込む", () => {
    expect(PAGE_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(WEB_PAGE).toContain(`version: "${PAGE_VERSION}"`);
  });

  it("画面の振る舞いに必要な要素がそろっている", () => {
    for (const id of ["log", "newer", "input", "input-highlight", "suggest", "pending", "composer", "status", "agents", "conversations", "sheet", "conn", "toast", "detail"]) {
      expect(WEB_PAGE).toContain(`id="${id}"`);
    }
  });
});
