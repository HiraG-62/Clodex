import { expect, it } from "vitest";
import { formatTokens } from "./token-format.js";

it("100 万未満は k、以上は M で書く", () => {
  expect(formatTokens(180_000)).toBe("180k");
  expect(formatTokens(999_400)).toBe("999k");
  expect(formatTokens(1_234_000)).toBe("1.2M");
  expect(formatTokens(1_030_000_000)).toBe("1030.0M");
});
