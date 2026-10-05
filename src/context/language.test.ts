import { describe, expect, it } from "vitest";
import { detectLanguage, languageDirective } from "./language.js";

describe("detectLanguage", () => {
  it("ja で始まるロケールは ja、それ以外は en", () => {
    expect(detectLanguage("ja-JP")).toBe("ja");
    expect(detectLanguage("ja")).toBe("ja");
    expect(detectLanguage("en-US")).toBe("en");
    expect(detectLanguage("fr-FR")).toBe("en");
  });
});

describe("languageDirective", () => {
  it("人が読む文章の言語を指定し、コード等はそのままにさせる", () => {
    const text = languageDirective("ja");
    expect(text).toContain("Japanese");
    expect(text).toMatch(/send_message/);
    expect(text).toMatch(/code/);
    expect(languageDirective("en")).toContain("English");
  });
});
