import { describe, expect, it } from "vitest";
import { WorkRecorder } from "./work-recorder.js";

describe("WorkRecorder", () => {
  it("コマンド全文と結果を Agent ごとの toolId で結び付ける", () => {
    const recorder = new WorkRecorder();
    for (const id of ["claude", "codex"] as const) recorder.record(id, { type: "turn_started" });
    recorder.record("codex", { type: "tool", name: "command", input: "short", command: "pnpm test", toolId: "same", cwd: "C:\\dev", exitCode: 3 });
    recorder.record("claude", { type: "tool", name: "Bash", input: "short", command: "pnpm typecheck", toolId: "same" });
    recorder.record("claude", { type: "tool_end", toolId: "unknown", failed: false });
    recorder.record("claude", { type: "tool_end", toolId: "same", failed: true });
    expect(recorder.lastWork("claude")?.commands).toEqual([{ toolId: "same", command: "pnpm typecheck", failed: true }]);
    expect(recorder.lastWork("codex")?.commands).toEqual([{ toolId: "same", command: "pnpm test", cwd: "C:\\dev", exitCode: 3 }]);
    recorder.record("claude", { type: "turn_started" });
    recorder.record("claude", { type: "tool_end", toolId: "same", exitCode: 0 });
    expect(recorder.lastWork("claude")?.commands).toEqual([]);
    expect(recorder.lastWork("codex")?.commands).toHaveLength(1);
  });

  it("先頭を捨ててコマンドを 200 件まで保持し、捨てた結果は無視する", () => {
    const recorder = new WorkRecorder();
    recorder.record("claude", { type: "turn_started" });
    for (let index = 0; index < 201; index++) {
      recorder.record("claude", { type: "tool", name: "Bash", input: "summary", command: `echo ${index}`, toolId: String(index) });
    }
    recorder.record("claude", { type: "tool_end", toolId: "0", failed: true });
    recorder.record("claude", { type: "tool_end", toolId: "200", exitCode: 0 });
    const commands = recorder.lastWork("claude")?.commands;
    expect(commands).toHaveLength(200);
    expect(commands?.[0]).toEqual({ toolId: "1", command: "echo 1" });
    expect(commands?.at(-1)).toEqual({ toolId: "200", command: "echo 200", exitCode: 0 });
  });

  it("toolId のないコマンドも記録し、他の tool と開始前の結果は無視する", () => {
    const recorder = new WorkRecorder();
    recorder.record("claude", { type: "tool_end", toolId: "missing", failed: true });
    expect(recorder.lastWork("claude")).toBeUndefined();
    recorder.record("codex", { type: "turn_started" });
    recorder.record("codex", { type: "tool", name: "command", input: "exit 0", command: "exit 0", exitCode: 0 });
    recorder.record("codex", { type: "tool", name: "Read", input: "a.ts" });
    expect(recorder.lastWork("codex")?.commands).toEqual([{ command: "exit 0", exitCode: 0 }]);
  });

  it("方針と直近 5 操作だけを復旧状態に記録する", () => {
    const recorder = new WorkRecorder();
    recorder.record("claude", { type: "turn_started" });
    recorder.record("claude", { type: "text", text: "方針\n続き" });
    for (let index = 0; index < 6; index++) recorder.record("claude", { type: "tool", name: "Read", input: String(index), files: ["a.ts"] });
    const state = recorder.recoveryState([], ["claude"], { claude: [], codex: [], gemini: [] });
    expect(state.lastWork?.claude).toEqual({ plan: "方針", actions: ["Read 1", "Read 2", "Read 3", "Read 4", "Read 5"] });
    expect(recorder.lastWork("claude")?.files.has("a.ts")).toBe(true);
    expect(recorder.recoveryWorkNote(state.lastWork?.claude)).toContain("Before the restart you were: 方針.");
  });
});
