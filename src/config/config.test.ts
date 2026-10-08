import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureUserConfigTemplate, loadConfig, saveUserLanguage } from "./config.js";

const setup = (files: { user?: unknown; project?: unknown } = {}) => {
  const base = mkdtempSync(join(tmpdir(), "clodex-config-"));
  const homeDir = join(base, "home");
  const projectRoot = join(base, "project");
  mkdirSync(join(homeDir, ".clodex"), { recursive: true });
  mkdirSync(projectRoot);
  const write = (path: string, content: unknown) =>
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  if (files.user !== undefined) write(join(homeDir, ".clodex", "config.json"), files.user);
  if (files.project !== undefined) write(join(projectRoot, ".clodex.json"), files.project);
  return { homeDir, projectRoot };
};

describe("saveUserLanguage", () => {
  it("書き込み失敗にも config.json のフルパスを付ける", () => {
    const { homeDir } = setup();
    const blocked = join(homeDir, "file");
    writeFileSync(blocked, "file");
    expect(() => saveUserLanguage(blocked, "en")).toThrow(join(blocked, ".clodex", "config.json"));
    expect(readFileSync(blocked, "utf8")).toBe("file");
  });
  it("他のキーと空の役割を保持し、不正な言語は保存しない", () => {
    const user = { primary: "codex", roles: { claude: "", codex: "実装" }, web: { port: 5000 } };
    const paths = setup({ user });
    saveUserLanguage(paths.homeDir, "ja");
    expect(JSON.parse(readFileSync(join(paths.homeDir, ".clodex", "config.json"), "utf8"))).toEqual({ ...user, language: "ja" });
    expect(() => saveUserLanguage(paths.homeDir, "fr" as "ja")).toThrow();
    expect(loadConfig(paths).language).toBe("ja");
  });
  it("設定がない場合も保存する", () => {
    const paths = setup();
    saveUserLanguage(paths.homeDir, "en");
    expect(loadConfig(paths).language).toBe("en");
  });
});

describe("loadConfig", () => {
  it("設定ファイルが無ければ空の設定", () => {
    expect(loadConfig(setup())).toEqual({});
  });

  it("worktree.setup を読む", () => {
    expect(loadConfig(setup({ project: { worktree: { setup: "pnpm install" } } }))).toEqual({ worktree: { setup: "pnpm install" } });
  });

  it("ユーザーの設定を読む", () => {
    const config = { primary: "codex", roles: { claude: "設計", codex: "実装" } };
    expect(loadConfig(setup({ user: config }))).toEqual(config);
  });

  it("ひな形の空の役割は未設定にする", () => {
    expect(loadConfig(setup({ user: { roles: { claude: "", codex: "" } } }))).toEqual({});
  });

  it("片方だけ記入した役割だけを設定する", () => {
    expect(loadConfig(setup({ user: { roles: { claude: "設計", codex: "" } } })))
      .toEqual({ roles: { claude: "設計" } });
  });

  it("UTF-8 BOM のある設定を読む", () => {
    expect(loadConfig(setup({ user: '\uFEFF{"primary":"codex"}' }))).toEqual({ primary: "codex" });
  });

  it("壊れた JSON は invalid JSON とファイル名を出す", () => {
    expect(() => loadConfig(setup({ project: "{ broken" }))).toThrow(/\.clodex\.json: invalid JSON/);
  });

  it("project の設定はトップレベルのキー単位でユーザーの設定を上書きする", () => {
    const paths = setup({
      user: { primary: "codex", roles: { claude: "設計", codex: "実装" }, limits: { maxMessagesPerChain: 10 } },
      project: { roles: { codex: "レビュー" } },
    });
    expect(loadConfig(paths)).toEqual({
      primary: "codex",
      roles: { codex: "レビュー" },
      limits: { maxMessagesPerChain: 10 },
    });
  });

  it("permission を読み、未知のレベルは拒否する", () => {
    expect(loadConfig(setup({ user: { permission: "full" } }))).toEqual({ permission: "full" });
    expect(() => loadConfig(setup({ user: { permission: "admin" } }))).toThrow(/permission/);
  });

  it("updateChannel を読み、未知のチャンネルは拒否する", () => {
    expect(loadConfig(setup({ user: { updateChannel: "dev" } })).updateChannel).toBe("dev");
    expect(() => loadConfig(setup({ user: { updateChannel: "beta" } }))).toThrow("updateChannel");
  });

  it("web の port を読み、範囲外は拒否する", () => {
    expect(loadConfig(setup({ user: { web: { port: 5000 } } }))).toEqual({ web: { port: 5000 } });
    expect(loadConfig(setup({ user: { web: {} } }))).toEqual({ web: {} });
    expect(() => loadConfig(setup({ user: { web: { port: 70000 } } }))).toThrow(/port/);
  });

  it("limits と usageAlert を読む", () => {
    const config = {
      limits: { maxMessagesPerChain: 8, maxReviewRoundsPerChain: 3, maxDelegationsPerChain: 4, maxDelegationDepth: 2 },
      usageAlert: { weeklyPaceThreshold: 20, fiveHourThreshold: 80 },
    };
    expect(loadConfig(setup({ project: config }))).toEqual(config);
  });

  it.each([
    ["壊れた JSON", "{ not json", /config\.json/],
    ["未知の primary", { primary: "gemini" }, /primary/],
    ["未知のキー", { unknown: 1 }, /unknown/],
    ["未知の Agent の役割", { roles: { gemini: "x" } }, /roles/],
    ["負の上限", { limits: { maxMessagesPerChain: -1 } }, /maxMessagesPerChain/],
  ])("%s はファイル名付きのエラーにする", (_, content, pattern) => {
    expect(() => loadConfig(setup({ user: content }))).toThrow(pattern);
  });
});

describe("ensureUserConfigTemplate", () => {
  it("無ければ 2 スペースの JSON でひな形を作る", () => {
    const { homeDir } = setup();
    ensureUserConfigTemplate(homeDir);
    const content = readFileSync(join(homeDir, ".clodex", "config.json"), "utf8");
    expect(content).toBe(`${JSON.stringify({ roles: { claude: "", codex: "" } }, null, 2)}\n`);
    expect(loadConfig({ homeDir, projectRoot: homeDir })).toEqual({});
  });

  it("既存の設定は変更しない", () => {
    const { homeDir } = setup({ user: '{"primary":"codex"}' });
    ensureUserConfigTemplate(homeDir);
    expect(readFileSync(join(homeDir, ".clodex", "config.json"), "utf8"))
      .toBe('{"primary":"codex"}');
  });

  it("書けなくても例外を出さない", () => {
    const { homeDir } = setup();
    const blockedHome = join(homeDir, "blocked");
    writeFileSync(blockedHome, "file");
    expect(() => ensureUserConfigTemplate(blockedHome)).not.toThrow();
  });
});

it.each(["{ broken", '{/* comment */"language":"ja"}', '{"unknown":true}'])("言語保存の読み込みエラーに設定ファイルのパスを付ける: %s", user => {
  const paths = setup({ user });
  expect(() => saveUserLanguage(paths.homeDir, "en")).toThrow(join(paths.homeDir, ".clodex", "config.json"));
  expect(readFileSync(join(paths.homeDir, ".clodex", "config.json"), "utf8")).toBe(user);
});
