import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_META } from "../../agents/agent-meta.js";
import { format } from "../../i18n/i18n.js";
import { ja, type MessageKey } from "../../i18n/messages.js";
import { brainstormHeading } from "./brainstorm-view.js";
import { createLogView } from "./log-view.js";
import { createPendingView } from "./pending-view.js";
import { createSettingsSheet } from "./settings-sheet.js";
import { createSheets } from "./sheets.js";
import { createStateView } from "./state-view.js";
import type { ClientContext } from "./store.js";

class ElementStub extends EventTarget {
  children: ElementStub[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style = { setProperty: vi.fn() };
  classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
  textContent = "";
  value = "";
  type = "";
  min = "";
  max = "";
  step = "";
  title = "";
  hidden = true;
  disabled = false;
  constructor(
    readonly tag = "div",
    readonly className = "",
  ) {
    super();
  }
  append(...nodes: ElementStub[]) {
    this.children.push(...nodes);
  }
  prepend(...nodes: ElementStub[]) {
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes: ElementStub[]) {
    this.children = nodes;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name);
  }
  focus() {}
  querySelector() {
    return undefined;
  }
  click() {
    this.dispatchEvent(new Event("click"));
  }
  descendants(): ElementStub[] {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }
}

afterEach(() => vi.unstubAllGlobals());

const setup = () => {
  const nodes = new Map<string, ElementStub>();
  const get = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, new ElementStub());
    return nodes.get(selector)!;
  };
  const documentStub = { activeElement: null, body: new ElementStub(), querySelectorAll: () => [] };
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("HTMLElement", ElementStub);
  const ctx = {
    $: get,
    el: (tag: string, cls = "", text = "") => {
      const node = new ElementStub(tag, cls);
      node.textContent = text;
      return node;
    },
    icon: (name: string) => new ElementStub("svg", name),
    iconButton: (_name: string, title: string, cls: string) => {
      const node = new ElementStub("button", cls);
      node.title = title;
      return node;
    },
    store: {
      state: {
        project: "C:/project",
        primary: "claude",
        agents: [],
        conversations: [{ id: "b", mode: "brainstorm", current: true, sessions: {}, updatedAt: "now" }],
        tabs: [],
      },
    },
    t: (key: MessageKey, params?: Record<string, string | number>) => format(ja[key], params),
    send: vi.fn(async () => true),
    openDevelop: vi.fn(),
    AGENTS: AGENT_META,
    wideUsage: { addEventListener: vi.fn() },
    mobile: { matches: false },
    input: new ElementStub(),
    closeUsage: vi.fn(),
    renderQuestionDock: vi.fn(),
    refreshUsage: vi.fn(),
    refreshOpenSheet: vi.fn(),
    renderPending: vi.fn(),
    syncPendingButtons: vi.fn(),
    syncTargetButtons: vi.fn(),
    shortDate: () => "今日",
    mark: () => new ElementStub(),
    STATUS_LABEL: { idle: "web.status.idle" },
  } as unknown as ClientContext;
  Object.assign(ctx, createSettingsSheet(ctx));
  Object.assign(ctx, createSheets(ctx));
  Object.assign(ctx, createPendingView(ctx));
  return { ctx, get };
};

describe("ブレストの画面", () => {
  it("開幕・周と反論役・まとめの理由を表示する", () => {
    const t = (key: MessageKey, params?: Record<string, string | number>) => format(ja[key], params);
    expect(brainstormHeading({ phase: "opening", total: 3 }, t)).toBe("開幕");
    expect(brainstormHeading({ phase: "round", round: 2, total: 3, advocate: "codex" }, t)).toBe("周 2/3 · 反論役 Codex");
    expect(brainstormHeading({ phase: "summary", total: 3, reason: "consensus" }, t)).toBe("まとめ · 合意");
    expect(brainstormHeading({ phase: "summary", total: 3, reason: "limit" }, t)).toBe("まとめ · 上限");
  });
  it("周回上限は既定3で最大値なし、参加のトグルをコマンドに渡す", async () => {
    const { ctx, get } = setup();
    ctx.openBrainstorm();
    const form = get("#sheet-body").children[0]!;
    const nodes = form.descendants();
    const rounds = nodes.find(node => node.tag === "input")!;
    expect(rounds.type).toBe("number");
    expect(rounds.value).toBe("3");
    expect(rounds.min).toBe("1");
    expect(rounds.max).toBe("");
    rounds.value = "100";
    nodes.find(node => node.tag === "textarea")!.value = "テーマ";
    nodes.find(node => node.className === "settings-switch")!.click();
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();
    expect(ctx.send).toHaveBeenCalledWith("/brainstorm 100 --join テーマ", expect.anything());
  });
  it.each(["", "C1 を採用"])("開発への指示を送る: %s", async instruction => {
    const { ctx, get } = setup();
    ctx.openDevelop();
    const form = get("#sheet-body").children[0]!;
    form.children[0]!.value = instruction;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();
    expect(ctx.send).toHaveBeenCalledWith(instruction ? "/develop C1 を採用" : "/develop", expect.anything());
  });
  it("保存済みのまとめだけ開発ボタンを表示する", () => {
    const { ctx } = setup();
    vi.spyOn(ctx, "openDevelop");
    const { renderItem } = createLogView(ctx);
    const summary = { kind: "brainstorm" as const, id: "s", at: "now", phase: "summary" as const, total: 3, reason: "consensus" as const };
    expect((renderItem(summary) as unknown as ElementStub).children).toHaveLength(0);
    const heading = renderItem({ ...summary, artifact: "C:/summary.md" }) as unknown as ElementStub;
    expect(heading.textContent).toBe("まとめ · 合意");
    expect(heading.children[0]!.textContent).toBe("開発へ");
    heading.children[0]!.click();
    expect(ctx.openDevelop).toHaveBeenCalledOnce();
    ctx.store.state!.conversations[0]!.mode = undefined;
    expect((renderItem({ ...summary, artifact: "C:/summary.md" }) as unknown as ElementStub).children).toHaveLength(0);
  });
  it("人の番だけ入力欄の上にパス・まとめへの操作を出す", () => {
    const { ctx, get } = setup();
    ctx.store.state!.brainstorm = { phase: "human", round: 0, total: 3 };
    const view = createStateView(ctx);
    view.renderState();
    const dock = get("#composer").children[0]!;
    expect(dock.hidden).toBe(false);
    expect(dock.children[0]!.textContent).toBe("あなたの番");
    dock.children[1]!.click();
    dock.children[2]!.click();
    expect(ctx.send).toHaveBeenCalledWith("/pass", expect.anything());
    expect(ctx.send).toHaveBeenCalledWith("/conclude", expect.anything());
    ctx.store.state!.brainstorm.phase = "round";
    view.renderState();
    expect(dock.hidden).toBe(true);
  });
  it("引き継いだ会話の一覧とタブから元の会話に戻れる", () => {
    const { ctx, get } = setup();
    ctx.store.state!.conversations[0]!.from = { brainstorm: "original" };
    ctx.store.state!.tabs = [{ projectRoot: "C:/project", conversationId: "b", title: "開発", tabbed: true, current: true, from: { brainstorm: "original" } }];
    const view = createStateView(ctx);
    view.renderState();
    for (const root of [get("#conversations"), get("#conversation-tabs")]) {
      const source = root.descendants().find(node => node.title === "元のブレスト")!;
      expect(source).toBeDefined();
      source.click();
    }
    expect(ctx.send).toHaveBeenCalledWith("/tab original C:/project", expect.anything());
    expect(ctx.send).toHaveBeenCalledTimes(2);
  });
});
