import { describe, expect, it } from "vitest";
import { composeInputLine } from "./compose-input.js";

describe("composeInputLine", () => {
  it("コマンドと明示メンションは送り先を前置きしない", () => {
    for (const line of ["/status", "@codex hello", "!pnpm test"]) {
      expect(composeInputLine(line, "claude")).toBe(line);
    }
  });

  it("通常の入力だけ指定された Agent を前置きする", () => {
    expect(composeInputLine("hello", "codex")).toBe("@codex hello");
    expect(composeInputLine("hello", undefined)).toBe("hello");
  });
});
