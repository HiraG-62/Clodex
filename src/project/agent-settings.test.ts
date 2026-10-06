import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSettingsStore, agentSettingsPath, resolveStartSettings } from "./agent-settings.js";

const makePath = () => join(mkdtempSync(join(tmpdir(), "clodex-settings-")), "nested", "state.settings.json");

describe("agentSettingsPath", () => {
  it("会話の履歴と同じ名前の .settings.json にする", () => {
    expect(agentSettingsPath("C:\\home\\.clodex\\state\\E--dev-Clodex-1a2b3c4d.json"))
      .toBe("C:\\home\\.clodex\\state\\E--dev-Clodex-1a2b3c4d.settings.json");
  });
});

describe("AgentSettingsStore", () => {
  it("ファイルが無ければ空", () => {
    expect(new AgentSettingsStore(makePath()).load()).toEqual({});
  });

  it("切り替えた値を Agent ごとに保存し、既存の値に重ねる", () => {
    const path = makePath();
    const store = new AgentSettingsStore(path);
    store.update(["claude", "codex"], { permission: "full" });
    store.update(["claude"], { model: "haiku" });
    store.update(["codex"], { effort: "low" });

    expect(new AgentSettingsStore(path).load()).toEqual({
      claude: { permission: "full", model: "haiku" },
      codex: { permission: "full", effort: "low" },
    });
    // 一時ファイルを残さない
    expect(readdirSync(dirname(path))).toEqual(["state.settings.json"]);
  });

  it("壊れたファイル・形の違うファイルは空として扱う", () => {
    const path = makePath();
    new AgentSettingsStore(path).update(["claude"], { model: "haiku" });
    writeFileSync(path, "{ broken");
    expect(new AgentSettingsStore(path).load()).toEqual({});
    writeFileSync(path, JSON.stringify({ claude: { permission: "root" } }));
    expect(new AgentSettingsStore(path).load()).toEqual({});
  });

  it("壊れたファイルにも上書きして保存できる", () => {
    const path = makePath();
    new AgentSettingsStore(path).update(["claude"], { model: "haiku" });
    writeFileSync(path, "{ broken");
    new AgentSettingsStore(path).update(["codex"], { effort: "high" });
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ codex: { effort: "high" } });
  });
});

describe("resolveStartSettings", () => {
  it("起動オプション > 保存した値 > 設定ファイルの順に決める", () => {
    expect(resolveStartSettings({
      saved: { claude: { permission: "full", model: "opus", effort: "high" }, codex: { model: "gpt-x" } },
      configPermission: "read-only",
      models: { codex: "gpt-cli" },
    })).toEqual({
      claude: { permission: "full", model: "opus", effort: "high" },
      codex: { permission: "read-only", model: "gpt-cli" },
    });
  });

  it("何も無ければ空の設定", () => {
    expect(resolveStartSettings({ saved: {}, models: {} })).toEqual({ claude: {}, codex: {} });
  });
});

it("上限の有効な保存値だけを読み、Agent の設定と併存する", () => {
  const path = makePath();
  const store = new AgentSettingsStore(path);
  store.update(["claude"], { model: "haiku" });
  writeFileSync(path, JSON.stringify({ claude: { model: "haiku" }, limits: { maxMessagesPerChain: 16, maxDelegationDepth: 101, unknown: 2, maxDelegationsPerChain: 1.5 } }));
  expect(store.load()).toEqual({ claude: { model: "haiku" }, limits: { maxMessagesPerChain: 16 } });
  store.setLimits({ maxDelegationDepth: 4 });
  expect(store.load()).toEqual({ claude: { model: "haiku" }, limits: { maxDelegationDepth: 4 } });
  store.setLimits({});
  expect(store.load()).toEqual({ claude: { model: "haiku" } });
});
