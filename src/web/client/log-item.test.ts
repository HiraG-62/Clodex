import { describe, expect, it, vi } from "vitest";
import { emptyTaskMetrics } from "../../coordinator/task-metrics-summary.js";
import { t } from "../../i18n/i18n.js";
import { createLogItem, splitReferenceFiles } from "./log-item.js";
import type { ClientContext } from "./store.js";

it.each([false, true])("tell を省略しない Markdown と画像プレビューで表示する: 添付=%s", embedded => {
  interface TestNode {
    tag: string;
    className: string;
    textContent: string;
    innerHTML: string;
    dataset: Record<string, string>;
    children: TestNode[];
    append: (...children: TestNode[]) => void;
    addEventListener: () => void;
  }
  const created: TestNode[] = [];
  const el = (tag: string, className = "", textContent = ""): TestNode => {
    const node: TestNode = {
      tag,
      className,
      textContent,
      innerHTML: "",
      dataset: {},
      children: [],
      append: (...children) => node.children.push(...children),
      addEventListener: () => {},
    };
    created.push(node);
    return node;
  };
  vi.stubGlobal("document", { addEventListener: () => {}, createElement: el, createTreeWalker: () => ({ nextNode: () => false }) });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  try {
    const ctx = {
      el,
      mark: () => el("span", "mark"),
      clock: () => "12:00",
      t,
      AGENTS: { codex: { name: "Codex" } },
      TURN_LABEL: {},
      store: { opened: new Map() },
      fileUrl: () => "/preview",
    } as unknown as ClientContext;
    const renderer = createLogItem(ctx);
    const body = `**発見**\n${"長い本文".repeat(200)}\nC:/artifacts/shot.png`;
    const tell = { kind: "tell" as const, id: "tell_1", agent: "codex" as const, at: "now", body };
    const node = embedded
      ? renderer.renderTurn({ kind: "turn", id: "t", at: "now", agent: "codex", status: "completed", steps: [], text: "", tells: [tell] })
      : renderer.renderTell(tell);
    expect(node).toBeDefined();
    expect(created.some(entry => entry.innerHTML.includes("<strong>発見</strong>") && entry.innerHTML.includes("長い本文".repeat(200)))).toBe(true);
    expect(created.filter(entry => entry.className === "mark")).toHaveLength(1);
    expect(created.some(entry => entry.className === "image-preview" && entry.dataset.path === "C:/artifacts/shot.png")).toBe(true);
    expect(created.some(entry => ["handoff", "question-card", "route"].includes(entry.className))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

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
