import { describe, expect, it, vi } from "vitest";
import { emptyTaskMetrics } from "../../coordinator/task-metrics-summary.js";
import { t } from "../../i18n/i18n.js";
import { createLogItem, splitReferenceFiles } from "./log-item.js";
import type { ClientContext } from "./store.js";
import type { TimelineItem } from "./timeline.js";

it.each(["tell", "message", "question", "question-message"] as const)("最終応答の表示先を添付で分ける: %s", attachment => {
  interface TestNode {
    className: string;
    textContent: string;
    innerHTML: string;
    children: TestNode[];
    append: (...children: TestNode[]) => void;
    addEventListener: () => void;
  }
  const el = (_tag: string, className = "", textContent = ""): TestNode => {
    const node: TestNode = {
      className,
      textContent,
      innerHTML: "",
      children: [],
      append: (...children) => node.children.push(...children),
      addEventListener: () => {},
    };
    return node;
  };
  const contents = (node: TestNode): string => [node.textContent, node.innerHTML, ...node.children.map(contents)].join("\n");
  vi.stubGlobal("document", { addEventListener: () => {} });
  try {
    const ctx = {
      el,
      mark: () => el("span", "mark"),
      clock: () => "12:00",
      t,
      AGENTS: { codex: { name: "Codex" } },
      TURN_LABEL: {},
      store: { opened: new Map() },
    } as unknown as ClientContext;
    const turn: Extract<TimelineItem, { kind: "turn" }> = {
      kind: "turn",
      id: "t",
      agent: "codex",
      at: "now",
      status: "completed",
      steps: [{ kind: "tool", name: "Read", input: "src/main.ts" }],
      text: "最終応答",
      tells: [
        { kind: "tell", id: "t1", agent: "codex", at: "now", body: "発見" },
        { kind: "tell", id: "t2", agent: "codex", at: "later", body: "判断" },
      ],
      ...(attachment === "message" || attachment === "question-message"
        ? { messages: [{ message: { id: "m", type: "RESULT", from: "codex", to: "claude", taskId: "T", repository: "root", createdAt: "now", body: "結果" } }] }
        : {}),
      ...(attachment === "question" || attachment === "question-message"
        ? { questions: [{ kind: "question", id: "q", agent: "codex", at: "now", questions: [{ question: "方針", options: [{ label: "A" }] }] }] }
        : {}),
    };
    const node = createLogItem(ctx).renderTurn(turn) as unknown as TestNode;
    const body = node.children.find(child => child.className === "body")!;
    const steps = node.children.find(child => child.className === "steps")!;
    expect(contents(body)).toContain("発見");
    expect(contents(body)).toContain("判断");
    if (attachment === "tell") {
      expect(contents(body)).toMatch(/発見[\s\S]*判断[\s\S]*最終応答/);
      expect(contents(steps)).not.toContain("最終応答");
      expect(contents(steps)).toContain("src/main.ts");
    } else if (attachment === "message") {
      expect(contents(body)).not.toContain("最終応答");
      expect(contents(steps)).toContain("最終応答");
    } else {
      expect(contents(body)).toMatch(/最終応答[\s\S]*方針/);
      expect(contents(body).match(/最終応答/g)).toHaveLength(1);
      expect(contents(steps)).not.toContain("最終応答");
      expect(contents(steps)).toContain("src/main.ts");
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["standalone", "tell", "question"])("本文を省略しない Markdown と画像プレビューで表示する: %s", attachment => {
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
    const body = `**発見**\n${"長い本文".repeat(200)}\n\n| 案 | 内容 |\n| --- | --- |\n| A | 詳細 |\n\nC:/artifacts/shot.png`;
    const tell = { kind: "tell" as const, id: "tell_1", agent: "codex" as const, at: "now", body };
    const node =
      attachment === "standalone"
        ? renderer.renderTell(tell)
        : renderer.renderTurn({
            kind: "turn",
            id: "t",
            at: "now",
            agent: "codex",
            status: "completed",
            steps: [],
            text: attachment === "question" ? body : "",
            ...(attachment === "tell"
              ? { tells: [tell] }
              : {
                  questions: [{ kind: "question", id: "q", agent: "codex", at: "now", questions: [{ question: "方針", options: [{ label: "A" }] }] }],
                }),
          });
    expect(node).toBeDefined();
    expect(created.some(entry => entry.innerHTML.includes("<strong>発見</strong>") && entry.innerHTML.includes("長い本文".repeat(200)))).toBe(true);
    expect(created.some(entry => entry.innerHTML.includes("<table>"))).toBe(true);
    expect(created.filter(entry => entry.className === "mark")).toHaveLength(1);
    expect(created.some(entry => entry.className === "image-preview" && entry.dataset.path === "C:/artifacts/shot.png")).toBe(true);
    if (attachment !== "question") expect(created.some(entry => ["handoff", "question-card", "route"].includes(entry.className))).toBe(false);
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
