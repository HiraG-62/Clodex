import { describe, expect, it, vi } from "vitest";
import { emptyTaskMetrics } from "../../coordinator/task-metrics-summary.js";
import { t } from "../../i18n/i18n.js";
import { createLogItem, splitReferenceFiles } from "./log-item.js";
import type { ClientContext } from "./store.js";

it("RESULT カードに task の累計を表示する", () => {
  const created: Array<{ className: string; textContent: string; append: (...nodes: unknown[]) => void }> = [];
  const el = (_tag: string, className = "", textContent = "") => {
    const node = { className, textContent, append: () => {} };
    created.push(node);
    return node;
  };
  vi.stubGlobal("document", { addEventListener: () => {} });
  try {
    const ctx = {
      el,
      mark: () => el("span"),
      clock: () => "12:00",
      t,
      store: {
        state: {
          taskMetrics: { results: { r: { ...emptyTaskMetrics("c", "T", ""), turns: 4, inputTokens: 1_200_000, durationMs: 2_280_000, questions: 1 } } },
        },
      },
    } as unknown as ClientContext;
    createLogItem(ctx).renderMessage({
      id: "r",
      at: "now",
      message: { id: "r", type: "RESULT", taskId: "T", from: "codex", to: "claude", body: "完了", repository: "test", createdAt: "now" },
    });
    expect(created.find(node => node.className === "task-metrics muted")?.textContent).toBe("4 turns · in 1.2M · 38 min · 1 question");
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("splitReferenceFiles", () => {
  it("3 件までは全件を表示する", () => {
    expect(splitReferenceFiles(["a", "b", "c"])).toEqual({ visible: ["a", "b", "c"], hidden: [] });
  });

  it("4 件以上は先頭の 3 件だけを表示する", () => {
    expect(splitReferenceFiles(["a", "b", "c", "d", "e"])).toEqual({ visible: ["a", "b", "c"], hidden: ["d", "e"] });
  });
});
