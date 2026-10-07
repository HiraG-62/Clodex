import { describe, expect, it } from "vitest";
import { resolvePendingSettings, isNavigationCommand, nextCommandStarts } from "./pending.js";
import type { AgentState } from "../../cli/shell.js";

const agent: AgentState = { id: "codex", status: "busy", sessionId: "x", permission: "edit", model: "old", effort: "medium", models: [{ value: "default", label: "Default", resolved: "new" }], usage: {} };

describe("resolvePendingSettings", () => {
  it("HTTP 応答前は長時間待っても保持し、応答後の猶予が過ぎてから解除する", () => {
    const pending = { codex: { model: "new" } };
    expect(resolvePendingSettings(pending, [agent], {}, 600_000)).toEqual(pending);
    const afterResponse = { codex: { model: 605_000 } };
    expect(resolvePendingSettings(pending, [agent], afterResponse, 604_999)).toEqual(pending);
    expect(resolvePendingSettings(pending, [agent], afterResponse, 605_000)).toEqual({});
  });
  it("拒否・失敗・別クライアントの変更で未反映でも期限で解除する", () => {
    const pending = { codex: { effort: "high", permission: "full" as const } };
    const deadlines = { codex: { effort: 100, permission: 200 } };
    expect(resolvePendingSettings(pending, [agent], deadlines, 99)).toEqual(pending);
    expect(resolvePendingSettings(pending, [agent], deadlines, 100)).toEqual({ codex: { permission: "full" } });
    expect(resolvePendingSettings(pending, [{ ...agent, effort: "low" }], deadlines, 200)).toEqual({});
    expect(resolvePendingSettings(pending, [], deadlines, 200)).toEqual({});
    expect(pending.codex.effort).toBe("high");
  });
  it("古い state では選択値を保持し、反映された設定だけ解除する", () => {
    const pending = { codex: { model: "default", effort: "high", permission: "full" as const } };
    expect(resolvePendingSettings(pending, [agent])).toEqual(pending);
    expect(resolvePendingSettings(pending, [{ ...agent, model: "new", effort: "high" }])).toEqual({ codex: { permission: "full" } });
    expect(resolvePendingSettings(pending, [{ ...agent, model: "new", effort: "high", permission: "full" }])).toEqual({});
    expect(pending.codex.model).toBe("default");
  });
  it("まだ state にいない Agent の設定は保持する", () => {
    expect(resolvePendingSettings({ codex: { effort: "high" } }, [])).toEqual({ codex: { effort: "high" } });
  });
});

it("画面全体が切り替わるコマンドだけを待つ", () => {
  for (const line of ["/new", "/new codex", "/resume 2", "/project E:\\dev", "/sandbox on"]) expect(isNavigationCommand(line)).toBe(true);
  for (const line of ["/newer", "/model codex x", "文章 /new", "!echo /new"]) expect(isNavigationCommand(line)).toBe(false);
});

it("開始・終了の ID ごとに時刻を保持し、通常の出力や旧 feed では変えない", () => {
  const first = nextCommandStarts({}, { id: 1, phase: "start" }, "first", "o1");
  const both = nextCommandStarts(first, { id: 2, phase: "start" }, "second", "o9");
  expect(both).toEqual({ 1: { at: "first", outputId: "o1" }, 2: { at: "second", outputId: "o9" } });
  expect(nextCommandStarts(both, undefined, "later")).toBe(both);
  expect(nextCommandStarts(both, { id: 2, phase: "exit" }, "later")).toEqual(first);
  expect(nextCommandStarts(first, { id: 1, phase: "exit" }, "later")).toEqual({});
  expect(nextCommandStarts(both, { id: 1, phase: "start" }, "duplicate")).toEqual(both);
  expect(first).toEqual({ 1: { at: "first", outputId: "o1" } });
  expect(nextCommandStarts({}, undefined, "legacy")).toEqual({});
});
