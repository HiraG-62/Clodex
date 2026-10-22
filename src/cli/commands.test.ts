import { describe, expect, it } from "vitest";
import { commandUsage, completeCommand, SLASH_COMMAND_NAMES, slashCommands } from "./commands.js";
import { parseInput } from "./input.js";

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
  it("/tab の固定と解除を補完し、ヘルプにも表示する", () => {
    expect(completeCommand("/tab ")).toEqual([["/tab keep ", "/tab close "], "/tab "]);
    expect(completeCommand("/tab k")).toEqual([["/tab keep "], "/tab k"]);
    expect(completeCommand("/tab unpin")).toEqual([[], "/tab unpin"]);
    expect(slashCommands().find(command => command.name === "tab")).toMatchObject({
      args: "[keep|close] <id> <project root>",
      argumentValues: ["keep", "close"],
    });
  });
  it("/handoff の Agent 名を補完する", () => {
    expect(completeCommand("/hand")).toEqual([["/handoff "], "/hand"]);
    expect(completeCommand("/handoff ")).toEqual([["/handoff claude ", "/handoff codex "], "/handoff "]);
    expect(completeCommand("/handoff co")).toEqual([["/handoff codex "], "/handoff co"]);
    expect(slashCommands().find(command => command.name === "handoff")).toMatchObject({ args: "<agent>", argumentValues: ["claude", "codex"] });
  });
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

it("/role preset の名前を補完する", () => {
  expect(completeCommand("/role p")[0]).toEqual(["/role preset "]);
  expect(completeCommand("/role preset c")[0]).toEqual(["/role preset codex-design "]);
});
