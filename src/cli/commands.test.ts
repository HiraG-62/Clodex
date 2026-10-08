import { describe, expect, it } from "vitest";
import { parseInput } from "./input.js";
import { SLASH_COMMAND_NAMES, commandUsage, completeCommand } from "./commands.js";

describe("SLASH_COMMAND_NAMES", () => {
  it("一覧のコマンドはすべて parseInput が解釈できる", () => {
    for (const name of SLASH_COMMAND_NAMES) {
      const parsed = parseInput(`/${name}`, "claude");
      expect(parsed.kind === "invalid" && parsed.message.startsWith("unknown command")).toBe(false);
    }
  });

  it("使い方は名前と引数をつなげる", () => {
    expect(commandUsage({ name: "model", args: "<agent> <model>" })).toBe("/model <agent> <model>");
    expect(commandUsage({ name: "status", args: "" })).toBe("/status");
  });
});

describe("completeCommand", () => {
  it("/language の値を補完する", () => {
    expect(completeCommand("/lang")).toEqual([["/language "], "/lang"]);
    expect(completeCommand("/language j")).toEqual([["/language ja "], "/language j"]);
    expect(completeCommand("/language e")).toEqual([["/language en "], "/language e"]);
  });
  it("コマンド名の入力中は前方一致の候補を返す", () => {
    expect(completeCommand("/co")).toEqual([["/context ", "/compact "], "/co"]);
    expect(completeCommand("/")[0]).toHaveLength(SLASH_COMMAND_NAMES.length);
  });

  it("引数の入力中やコマンドでない入力は補完しない", () => {
    expect(completeCommand("/model cl")).toEqual([[], "/model cl"]);
    expect(completeCommand("hello")).toEqual([[], "hello"]);
  });
});

it("/limits の名前と reset を補完する", () => {
  expect(completeCommand("/limits d")[0]).toEqual(["/limits delegations ", "/limits depth "]);
  expect(completeCommand("/limits r")[0]).toEqual(["/limits reviews ", "/limits reset "]);
});
