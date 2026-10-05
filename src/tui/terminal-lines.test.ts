import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../web/client/timeline.js";
import { terminalLines } from "./terminal-lines.js";

const labels = { working: "作業中", completed: "完了", failed: "失敗", interrupted: "中断", steps: "作業 {count} 件", you: "あなた" };

describe("terminalLines", () => {
  it("方針・作業件数・今の作業・最終応答を表示する", () => {
    const turn: TimelineItem = {
      kind: "turn", id: "t1", at: "2026-01-01T00:00:00Z", agent: "claude", status: "completed",
      plan: "**調査**します", steps: [{ kind: "tool", name: "Read", input: "src/a.ts" }, { kind: "say", text: "確認中" }],
      text: "# 完了\n結果です",
    };
    expect(terminalLines([turn], undefined, labels).join("\n")).toContain("調査します");
    expect(terminalLines([turn], undefined, labels).join("\n")).toContain("作業 2 件");
    expect(terminalLines([turn], undefined, labels).join("\n")).toContain("確認中");
    expect(terminalLines([turn], undefined, labels).join("\n")).toContain("完了\n結果です");
  });

  it("端末の行数に合わせて末尾を取る", () => {
    const items: TimelineItem[] = [{ kind: "output", id: "o1", text: "a\nb\nc" }];
    expect(terminalLines(items, 2, labels)).toEqual(["b", "c"]);
  });
});
