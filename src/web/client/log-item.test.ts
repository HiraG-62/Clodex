import { describe, expect, it, vi } from "vitest";
import { emptyTaskMetrics } from "../../coordinator/task-metrics-summary.js";
import { t } from "../../i18n/i18n.js";
import { createLogItem, splitReferenceFiles } from "./log-item.js";
import type { ClientContext } from "./store.js";
import type { TimelineItem } from "./timeline.js";

class TestNode {
  children: TestNode[] = [];
  parentNode?: TestNode;
  dataset: Record<string, string> = {};
  innerHTML = "";
  constructor(
    readonly tag: string,
    readonly className = "",
    public textContent = "",
  ) {}
  append(...children: TestNode[]) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }
  addEventListener() {}
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
  }
  replaceWith(next: TestNode) {
    if (!this.parentNode) return;
    next.parentNode = this.parentNode;
    this.parentNode.children[this.parentNode.children.indexOf(this)] = next;
  }
  get lastElementChild() {
    return this.children.at(-1);
  }
  querySelector(selector: string): TestNode | undefined {
    const match = selector.replace(":scope > ", "");
    return this.children.find(child => (match.startsWith(".") ? child.className.split(" ").includes(match.slice(1)) : child.tag === match));
  }
}
const contents = (node: TestNode): string => [node.textContent, node.innerHTML, ...node.children.map(contents)].join("\n");
const renderFixture = (run: (renderer: ReturnType<typeof createLogItem>, ctx: ClientContext) => void) => {
  const el = (tag: string, className = "", text = "") => new TestNode(tag, className, text);
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
      MS_PER_SECOND: 1000,
      SECONDS_PER_MINUTE: 60,
      store: { opened: new Map() },
      fileUrl: () => "/preview",
    } as unknown as ClientContext;
    run(createLogItem(ctx), ctx);
  } finally {
    vi.unstubAllGlobals();
  }
};
const sampleTurn = (): Extract<TimelineItem, { kind: "turn" }> => ({
  kind: "turn",
  id: "t",
  at: "2026-01-01T00:00:00Z",
  agent: "codex",
  status: "working",
  text: "",
  steps: [
    { kind: "say", text: `**発見**\n${"長い本文\n".repeat(20)}C:/artifacts/shot.png`, at: "now" },
    { kind: "tool", name: "Read", input: "a" },
    { kind: "say", text: "結果", at: "now" },
    { kind: "tool", name: "Read", input: "b" },
  ],
});
it("発言の全文と画像を本文に出し、tool は先頭の 1 つの作業に畳む", () =>
  renderFixture(renderer => {
    const node = renderer.renderTurn({ ...sampleTurn(), status: "completed", text: "結果" }) as unknown as TestNode;
    const blocks = node.querySelector(".turn-content")!.children;
    expect(blocks.map(block => block.className)).toEqual(["steps", "body md", "body md"]);
    expect(contents(blocks[1]!)).toContain("<strong>発見</strong>");
    expect(contents(blocks[1]!).match(/長い本文/g)).toHaveLength(20);
    expect(blocks[1]!.querySelector(".image-previews")?.children[0]?.dataset.path).toBe("C:/artifacts/shot.png");
    expect(contents(node).match(/結果/g)).toHaveLength(1);
    expect(contents(blocks[0]!)).not.toContain("発見");
    expect(blocks[0]!.querySelector("ol")?.children).toHaveLength(2);
  }));
it("途中の tool 追加では既存の本文・画像と作業の開閉状態を保つ", () =>
  renderFixture(renderer => {
    const previous = sampleTurn();
    const node = renderer.renderTurn(previous) as unknown as TestNode;
    const blocks = node.querySelector(".turn-content")!.children;
    const saved = [...blocks];
    const next = { ...previous, steps: [...previous.steps, { kind: "tool" as const, name: "Read", input: "c" }] };
    expect(renderer.updateTurn(node as unknown as HTMLElement, previous, next)).toEqual([]);
    expect(blocks).toEqual(saved);
    expect(contents(blocks[0]!)).toContain("c");
    expect(blocks[0]!.querySelector("ol")?.children).toHaveLength(3);
    const saying = { ...next, steps: [...next.steps, { kind: "say" as const, text: "途中の報告", at: "now" }] };
    renderer.updateTurn(node as unknown as HTMLElement, next, saying);
    expect(blocks.slice(0, 3)).toEqual(saved);
    expect(contents(node.querySelector(".now")!)).toContain("c");
    expect(contents(node.querySelector(".now")!)).not.toContain("途中の報告");
  }));
it.each([false, true])("message と最終応答を時系列に出し、自動の結果なら重複を省く: auto=%s", auto =>
  renderFixture(renderer => {
    const node = renderer.renderTurn({
      ...sampleTurn(),
      status: "completed",
      text: "結果",
      messages: [
        {
          message: {
            id: "m",
            type: "RESULT",
            from: "codex",
            to: "codex",
            taskId: "T",
            repository: "root",
            createdAt: "now",
            body: "カード",
            ...(auto ? { auto: true as const } : {}),
          },
        },
      ],
    }) as unknown as TestNode;
    const blocks = node.querySelector(".turn-content")!.children;
    expect(blocks.at(-1)?.className).toBe("handoff");
    expect(contents(node).includes("結果")).toBe(!auto);
    expect(contents(node)).toContain("カード");
  }),
);

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

it("質問と message の前後に発言を本文として出す", () =>
  renderFixture(renderer => {
    const turn = {
      ...sampleTurn(),
      status: "completed" as const,
      text: "最終",
      steps: [
        { kind: "say" as const, text: "説明", at: "now" },
        { kind: "say" as const, text: "最終", at: "later" },
      ],
      questions: [{ kind: "question" as const, id: "q", agent: "codex" as const, at: "now", questions: [{ question: "選択", options: [{ label: "A" }] }] }],
      messages: [
        {
          message: {
            id: "m",
            type: "QUESTION" as const,
            from: "codex" as const,
            to: "codex" as const,
            taskId: "T",
            repository: "root",
            createdAt: "now",
            body: "相談",
          },
        },
      ],
      attachmentOrder: [
        { kind: "question" as const, id: "q", stepIndex: 1 },
        { kind: "message" as const, id: "m", stepIndex: 1 },
      ],
    };
    const node = renderer.renderTurn(turn) as unknown as TestNode;
    expect(node.querySelector(".turn-content")!.children.map(block => block.className)).toEqual(["body md", "question-card", "handoff", "body md"]);
    expect(contents(node)).toMatch(/説明[\s\S]*選択[\s\S]*相談[\s\S]*最終/);
  }));
