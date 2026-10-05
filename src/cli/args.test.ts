import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";

describe("parseCliArgs", () => {
  it("未指定の option は undefined（既定値は設定ファイルとあわせて決める）", () => {
    expect(parseCliArgs([])).toEqual({ models: {} });
  });

  it("全 option を読む", () => {
    expect(parseCliArgs([
      "--project", "C:\\dev\\app", "--primary", "codex", "--claude-model", "haiku", "--codex-model", "gpt-5.5",
    ])).toEqual({ project: "C:\\dev\\app", primary: "codex", models: { claude: "haiku", codex: "gpt-5.5" } });
  });

  it("未知の primary はエラー", () => {
    expect(() => parseCliArgs(["--primary", "gemini"])).toThrow(/--primary/);
  });

  it("未知の option はエラー", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrow();
  });
});
