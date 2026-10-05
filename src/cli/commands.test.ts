import { describe, expect, it } from "vitest";
import { parseInput } from "./input.js";
import { SLASH_COMMANDS, commandUsage, completeCommand } from "./commands.js";

describe("SLASH_COMMANDS", () => {
  it("一覧のコマンドはすべて parseInput が解釈できる", () => {
    for (const command of SLASH_COMMANDS) {
      const parsed = parseInput(`/${command.name}`, "claude");
      expect(parsed.kind === "invalid" && parsed.message.startsWith("unknown command")).toBe(false);
    }
  });

  it("使い方は名前と引数をつなげる", () => {
    expect(commandUsage({ name: "model", args: "<agent> <model>", description: "" })).toBe("/model <agent> <model>");
    expect(commandUsage({ name: "status", args: "", description: "" })).toBe("/status");
  });
});

describe("completeCommand", () => {
  it("コマンド名の入力中は前方一致の候補を返す", () => {
    expect(completeCommand("/co")).toEqual([["/compact "], "/co"]);
    expect(completeCommand("/")[0]).toHaveLength(SLASH_COMMANDS.length);
  });

  it("引数の入力中やコマンドでない入力は補完しない", () => {
    expect(completeCommand("/model cl")).toEqual([[], "/model cl"]);
    expect(completeCommand("hello")).toEqual([[], "hello"]);
  });
});
