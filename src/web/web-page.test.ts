import { describe, expect, it } from "vitest";
import { WEB_PAGE } from "./web-page.js";

describe("WEB_PAGE", () => {
  it("埋め込んだ script が構文として正しい（実行はしない）", () => {
    const script = WEB_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("画面の振る舞いに必要な要素がそろっている", () => {
    for (const id of ["log", "newer", "input", "composer", "status", "agents", "conversations", "sheet", "conn", "toast", "detail"]) {
      expect(WEB_PAGE).toContain(`id="${id}"`);
    }
  });
});
