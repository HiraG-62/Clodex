import { describe, expect, it } from "vitest";
import { WorkRecorder } from "./work-recorder.js";

describe("WorkRecorder", () => {
  it("方針と直近 5 操作だけを復旧状態に記録する", () => {
    const recorder = new WorkRecorder();
    recorder.record("claude", { type: "turn_started" });
    recorder.record("claude", { type: "text", text: "方針\n続き" });
    for (let index = 0; index < 6; index++) recorder.record("claude", { type: "tool", name: "Read", input: String(index), files: ["a.ts"] });
    const state = recorder.recoveryState([], ["claude"], { claude: [], codex: [] });
    expect(state.lastWork?.claude).toEqual({ plan: "方針", actions: ["Read 1", "Read 2", "Read 3", "Read 4", "Read 5"] });
    expect(recorder.lastWork("claude")?.files.has("a.ts")).toBe(true);
    expect(recorder.recoveryWorkNote(state.lastWork?.claude)).toContain("Before the restart you were: 方針.");
  });
});
