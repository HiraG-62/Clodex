import { describe, expect, it } from "vitest";
import { hubCommands, parseCliArgs } from "./args.js";

describe("parseCliArgs", () => {
  it("未指定の option は undefined（既定値は設定ファイルとあわせて決める）", () => {
    expect(parseCliArgs([])).toEqual({ models: {}, resume: false, web: false, serve: false });
  });

  it("全 option を読む", () => {
    expect(
      parseCliArgs(["--project", "C:\\dev\\app", "--primary", "codex", "--claude-model", "haiku", "--codex-model", "gpt-5.5", "--resume", "--web"]),
    ).toEqual({ project: "C:\\dev\\app", primary: "codex", models: { claude: "haiku", codex: "gpt-5.5" }, resume: true, web: true, serve: false });
  });

  it("serve は project 省略可で Web を起動する", () => {
    expect(parseCliArgs(["serve"])).toMatchObject({ serve: true, web: true });
    expect(parseCliArgs(["serve"]).project).toBeUndefined();
    expect(parseCliArgs(["serve", "--project", "C:\\dev\\app"])).toMatchObject({ serve: true, web: true, project: "C:\\dev\\app" });
  });

  it("未知の primary はエラー", () => {
    expect(() => parseCliArgs(["--primary", "gemini"])).toThrow(/--primary/);
  });

  it("未知の option はエラー", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrow();
  });
});

describe("hubCommands", () => {
  it("option が無ければ起動した場所の project を開くだけ", () => {
    expect(hubCommands(parseCliArgs([]), "C:\\dev\\app")).toEqual({ commands: ["/project C:\\dev\\app"], ignored: [] });
  });

  it("option を Hub へのコマンドに変え、変えられないものは ignored に入れる", () => {
    const args = parseCliArgs(["--project", "sub", "--primary", "codex", "--claude-model", "haiku", "--codex-model", "gpt-5.5", "--resume", "--web"]);
    expect(hubCommands(args, "C:\\dev\\app")).toEqual({
      commands: ["/project C:\\dev\\app\\sub", "/primary codex", "/model claude haiku", "/model codex gpt-5.5"],
      ignored: ["--resume", "--web"],
    });
  });
});
