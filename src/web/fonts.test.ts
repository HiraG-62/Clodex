import { describe, expect, it } from "vitest";
import { rewriteFontCss } from "./fonts.js";

describe("rewriteFontCss", () => {
  it("woff2 の URL を版付きの Hub URL に変え、unicode-range を保つ", () => {
    const source = `@font-face {
  font-family: 'Zen Kaku Gothic New';
  font-display: swap;
  src: url(./files/zen-kaku-gothic-new-1-400-normal.woff2) format('woff2'), url(./files/zen-kaku-gothic-new-1-400-normal.woff) format('woff');
  unicode-range: U+3000-303f;
}`;
    expect(rewriteFontCss(source, "zen-kaku-gothic-new", "5.3.0")).toBe(`@font-face {
  font-family: 'Zen Kaku Gothic New';
  font-display: swap;
  src: url(/fonts/zen-kaku-gothic-new@5.3.0/zen-kaku-gothic-new-1-400-normal.woff2) format('woff2');
  unicode-range: U+3000-303f;
}`);
  });
});
