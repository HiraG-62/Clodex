import { describe, expect, it } from "vitest";
import { setLanguage } from "../i18n/i18n.js";
import { commandResultMessage, RESULT_MAX_CHARS, RESULT_MAX_LINES } from "./command-result.js";

describe("commandResultMessage", () => {
  it("コマンド・終了コード・出力と対応の指示を書く", () => {
    setLanguage("ja");
    const text = commandResultMessage("pnpm test", { code: 1, stopped: false, output: ["FAIL a.test.ts"] });
    expect(text).toContain("pnpm test");
    expect(text).toContain("exit 1");
    expect(text).toContain("FAIL a.test.ts");
    expect(text).toContain("必要なら対応");
  });

  it("出力は末尾の行と文字数に絞り、省いたことを書く", () => {
    setLanguage("en");
    const output = Array.from({ length: RESULT_MAX_LINES + 5 }, (_, i) => `line ${i}`);
    const text = commandResultMessage("x", { code: 0, stopped: false, output });
    expect(text).not.toContain("line 4\n");
    expect(text).toContain(`line ${RESULT_MAX_LINES + 4}`);
    expect(text).toContain("5 lines omitted");
    const long = commandResultMessage("x", { code: 0, stopped: false, output: ["a".repeat(RESULT_MAX_CHARS + 10)] });
    expect(long.length).toBeLessThan(RESULT_MAX_CHARS + 500);
  });

  it("起動の失敗はエラーを結果として書く", () => {
    setLanguage("en");
    expect(commandResultMessage("x", { code: null, stopped: false, error: "spawn failed", output: [] })).toContain("spawn failed");
  });
});
