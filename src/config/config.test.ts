import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

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

describe("loadConfig", () => {
  it("設定ファイルが無ければ空の設定", () => {
    expect(loadConfig(setup())).toEqual({});
  });

  it("ユーザーの設定を読む", () => {
    const config = { primary: "codex", roles: { claude: "設計", codex: "実装" } };
    expect(loadConfig(setup({ user: config }))).toEqual(config);
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
