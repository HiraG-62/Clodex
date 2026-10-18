import { describe, expect, it, vi } from "vitest";
import { emptyTaskMetrics } from "../../coordinator/task-metrics-summary.js";
import { t } from "../../i18n/i18n.js";
import { createLogItem, splitReferenceFiles } from "./log-item.js";
import type { ClientContext } from "./store.js";

it.each([false, true])("証跡の場所・差分と設計書検査を表示する: 空=%s", empty => {
  const created: Array<{ tag: string; className: string; textContent: string }> = [];
  const el = (tag: string, className = "", textContent = "") => {
    const node = { tag, className, textContent, append: () => {}, addEventListener: () => {} };
    created.push(node);
    return node;
  };
  vi.stubGlobal("document", { addEventListener: () => {} });
  try {
    const ctx = { el, mark: () => el("span"), clock: () => "12:00", t, store: { opened: new Map() } } as unknown as ClientContext;
    createLogItem(ctx).renderMessage({
      id: "r",
      at: "now",
      message: {
        id: "r",
        type: "RESULT",
        taskId: "T",
        from: "codex",
        to: "claude",
        body: "完了",
        repository: "test",
        createdAt: "now",
        evidence: {
          root: "C:/project/worktree",
          checks: [{ command: "pnpm test", ran: true, exitCode: 1 }],
          changed: empty ? [] : [{ path: "src/a.ts", scope: "forbidden", peer: true }],
        },
        specCheck: { command: "check", exitCode: 0, output: "ok" },
      },
    });
    expect(created.some(node => node.className.includes("verification-warning") && node.textContent.includes("pnpm test"))).toBe(true);
    expect(created.some(node => node.tag === "details" && node.className === "verification-files")).toBe(true);
    expect(created.some(node => node.tag === "small" && node.textContent === "C:/project/worktree")).toBe(true);
    if (empty) expect(created.some(node => node.tag === "li" && node.textContent === "None")).toBe(true);
    else expect(created.some(node => node.className.includes("verification-warning") && node.textContent.includes("src/a.ts [forbidden]"))).toBe(true);
    expect(created.some(node => node.tag === "details" && node.className === "spec-check")).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

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
