import { describe, expect, it } from "vitest";
import type { CliArgs } from "./cli/args.js";
import { initialProject, shouldStartWeb } from "./startup-options.js";

const args = (changes: Partial<CliArgs> = {}): CliArgs => ({ models: {}, resume: false, web: false, serve: false, ...changes });

describe("startup options", () => {
  it("明示した project を優先する", () => {
    expect(initialProject(args({ project: "E:\\dev\\Clodex", serve: true }), "E:\\other", "E:\\saved")).toBe("E:\\dev\\Clodex");
  });

  it("serve は前回の project、通常起動は cwd を選ぶ", () => {
    expect(initialProject(args({ serve: true }), "E:\\cwd", "E:\\saved")).toBe("E:\\saved");
    expect(initialProject(args({ serve: true }), "E:\\cwd")).toBeUndefined();
    expect(initialProject(args(), "E:\\cwd", "E:\\saved")).toBe("E:\\cwd");
  });

  it("Web 指定か設定があると起動する", () => {
    expect(shouldStartWeb(args(), false)).toBe(false);
    expect(shouldStartWeb(args({ web: true }), false)).toBe(true);
    expect(shouldStartWeb(args(), true)).toBe(true);
  });
});
