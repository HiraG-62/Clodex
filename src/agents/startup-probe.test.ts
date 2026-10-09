import { describe, expect, it } from "vitest";
import { createFakeSpawner, flush } from "./fake-agent-process.js";
import { fetchStartupProbe, parseClaudeModels, parseClaudeUsage, parseCodexModels, parseCodexUsage } from "./startup-probe.js";
import { modelLabel } from "./model-catalog.js";

const CLAUDE_MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
];
const claudeResponse = { type: "control_response", response: { subtype: "success", request_id: "model-catalog", response: { models: CLAUDE_MODELS } } };
const usageResponse = { type: "control_response", response: { subtype: "success", request_id: "startup-usage", response: { rate_limits: {
  five_hour: { utilization: 26, resets_at: "2026-10-06T02:39:59.533Z" },
  seven_day: { utilization: 42, resets_at: "2026-10-13T02:39:59.000Z" },
} } } };

describe("model catalog", () => {
  it("Claude の応答を表示名と解決済み model に変換する", () => {
    expect(parseClaudeModels(claudeResponse)).toEqual([
      { value: "default", label: "Default (Opus 5.5)", resolved: "claude-opus-5-5" },
      { value: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5" },
      { value: "fable", label: "Fable 5.1", resolved: "claude-fable-5-1" },
    ]);
    expect(parseClaudeModels({ response: {} })).toEqual([]);
  });

  it("Codex の hidden を除外し、cursor を返す", () => {
    expect(parseCodexModels({ data: [
      { model: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false },
      { model: "old", displayName: "Old", hidden: true },
    ], nextCursor: "page-2" })).toEqual({ models: [{ value: "gpt-6-astra", label: "GPT-6-Astra" }], nextCursor: "page-2" });
  });

  it("Claude の percent と ISO 時刻を rate_limit event に変換する", () => {
    expect(parseClaudeUsage(usageResponse)).toEqual({ type: "rate_limit",
      fiveHour: { usedPercent: 26, resetsAt: Date.parse("2026-10-06T02:39:59.533Z") / 1000 },
      weekly: { usedPercent: 42, resetsAt: Date.parse("2026-10-13T02:39:59.000Z") / 1000 },
    });
    expect(parseClaudeUsage({ response: { response: { rate_limits: { five_hour: { utilization: 10, resets_at: "bad" } } } } }))
      .toEqual({ type: "rate_limit" });
  });

  it("Codex の利用枠は primary/secondary を時間で分類する", () => {
    expect(parseCodexUsage({ rateLimits: { primary: { usedPercent: 2, resetsAt: 100, windowDurationMins: 10080 },
      secondary: { usedPercent: 30, resetsAt: 200, windowDurationMins: 300 } } })).toEqual({
      type: "rate_limit", fiveHour: { usedPercent: 30, resetsAt: 200 }, weekly: { usedPercent: 2, resetsAt: 100 },
    });
  });

  it("値一致を先に見て、解決済み model は default 以外を優先する", () => {
    const models = parseClaudeModels(claudeResponse);
    expect(modelLabel("default", models)).toBe("Default (Opus 5.5)");
    expect(modelLabel("claude-opus-5-5", models)).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5-1", models)).toBe("Fable 5.1");
    expect(modelLabel("custom", models)).toBe("custom");
    expect(modelLabel(undefined, models)).toBe("default");
  });

  it("短命プロセスを並列起動し Codex の全ページを読む", async () => {
    const spawner = createFakeSpawner((message) => {
      if (message.method === "initialize") return {};
      if (message.method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 2, resetsAt: 2000000000, windowDurationMins: 10080 } } };
      if (message.method !== "model/list") return undefined;
      const params = message.params as { cursor?: string };
      return params.cursor
        ? { data: [{ model: "gpt-6-sol", displayName: "GPT-6-Sol" }], nextCursor: null }
        : { data: [{ model: "gpt-6-astra", displayName: "GPT-6-Astra" }], nextCursor: "page-2" };
    });
    const pending = fetchStartupProbe("C:\\repo", spawner.spawn);
    await flush();
    const claude = spawner.processes[0]!;
    expect(claude.written[0]).toMatchObject({ type: "control_request", request: { subtype: "initialize" } });
    claude.emit(claudeResponse);
    expect(claude.written[1]).toMatchObject({ request: { subtype: "get_usage" } });
    claude.emit(usageResponse);
    const probe = await pending;
    expect(probe.models.claude.map((item) => item.label)).toEqual(["Default (Opus 5.5)", "Opus 5.5", "Fable 5.1"]);
    expect(probe.models.codex.map((item) => item.value)).toEqual(["gpt-6-astra", "gpt-6-sol"]);
    expect(probe.usage.claude?.fiveHour?.usedPercent).toBe(26);
    expect(probe.usage.codex?.weekly?.usedPercent).toBe(2);
    expect(spawner.calls.map((call) => call.command)).toEqual(["claude", "codex"]);
    expect(spawner.processes.every((proc) => proc.killed)).toBe(true);
  });

  it("起動失敗またはタイムアウトなら空にしてプロセスを終了する", async () => {
    const spawner = createFakeSpawner();
    expect(await fetchStartupProbe("C:\\repo", spawner.spawn, 1)).toEqual({ models: { claude: [], codex: [] }, usage: {} });
    expect(spawner.processes.every((proc) => proc.killed)).toBe(true);
    const failed = createFakeSpawner(undefined, { spawnError: new Error("missing CLI") });
    expect(await fetchStartupProbe("C:\\repo", failed.spawn)).toEqual({ models: { claude: [], codex: [] }, usage: {} });
  });
});
