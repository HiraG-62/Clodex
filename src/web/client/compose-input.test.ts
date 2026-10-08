import { describe, expect, it } from "vitest";
import { parseInput } from "../../cli/input.js";
import { composeInputLine } from "./compose-input.js";

describe("composeInputLine", () => {
  it("コマンドと明示メンションは送り先を前置きしない", () => {
    for (const line of ["/status", "@codex hello", "!pnpm test"]) {
      expect(composeInputLine(line, "claude")).toBe(line);
    }
  });

  it("!> は結果の渡し先として送り先を前置きする", () => {
    expect(composeInputLine("!> pnpm test", "codex")).toBe("@codex !> pnpm test");
    expect(composeInputLine("!> pnpm test", undefined)).toBe("!> pnpm test");
  });

  it("/context は選択中の送り先を前置きする", () => {
    expect(composeInputLine("/context 依頼", "codex")).toBe("@codex /context 依頼");
    expect(composeInputLine("/context 依頼", undefined)).toBe("/context 依頼");
  });

  it("通常の入力だけ指定された Agent を前置きする", () => {
    expect(composeInputLine("hello", "codex")).toBe("@codex hello");
    expect(composeInputLine("hello", undefined)).toBe("hello");
  });

  it("ファイル参照で始まる入力にも選択中の Agent を前置きする", () => {
    expect(composeInputLine("@20261008T144301.png 画像を見て", "codex"))
      .toBe("@codex @20261008T144301.png 画像を見て");
    expect(composeInputLine("@src/a.ts を直して", "codex")).toBe("@codex @src/a.ts を直して");
    expect(composeInputLine("@all 同時に見て", "codex")).toBe("@all 同時に見て");
    expect(parseInput(composeInputLine("@20261008T144301.png 画像を見て", "codex"), "claude"))
      .toEqual({ kind: "send", agent: "codex", text: "@20261008T144301.png 画像を見て" });
  });
});
