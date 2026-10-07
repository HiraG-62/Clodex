import { describe, expect, it } from "vitest";
import { resolvePendingSettings, isNavigationCommand, nextCommandStart } from "./pending.js";
import type { AgentState } from "../../cli/shell.js";

const agent: AgentState = { id: "codex", status: "busy", sessionId: "x", permission: "edit", model: "old", effort: "medium", models: [{ value: "default", label: "Default", resolved: "new" }], usage: {} };

describe("resolvePendingSettings", () => {
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

it("コマンドの開始から終了・失敗まで経過時間を保持する", () => {
  expect(nextCommandStart(undefined, "$ pnpm test", "now")).toBe("now");
  expect(nextCommandStart("start", "result", "now")).toBe("start");
  for (const text of ["exit 0 (2s)", "stopped (1s)", "error: failure"]) expect(nextCommandStart("start", text, "now")).toBeUndefined();
  expect(nextCommandStart("old", "exit 0 (1s)\n$ next", "now")).toBe("now");
});
