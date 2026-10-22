import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebState } from "../web-feed.js";
import { createConversationSheets } from "./conversation-sheets.js";
import { createStateView } from "./state-view.js";
import type { ClientContext } from "./store.js";

class ElementStub extends EventTarget {
  children: ElementStub[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  title = "";
  textContent = "";
  value = "";
  constructor(readonly className = "") {
    super();
  }
  append(...nodes: ElementStub[]) {
    this.children.push(...nodes);
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
}

const PROJECT = "C:\\my projects\\app";
const conversation = (tabbed: boolean): WebState["conversations"][number] => ({
  id: "saved",
  title: "会話",
  startedAt: "",
  updatedAt: "",
  sessions: {},
  pinned: true,
  tabbed,
  current: true,
});

function setup() {
  const nodes = new Map<string, ElementStub>();
  const get = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, new ElementStub());
    return nodes.get(selector)!;
  };
  const ctx = {
    $: get,
    el: (_tag: string, className = "", text = "") => {
      const node = new ElementStub(className);
      node.textContent = text;
      return node;
    },
    icon: () => new ElementStub(),
    mark: () => new ElementStub(),
    iconButton: (icon: string, label: string, className: string) => {
      const node = new ElementStub(className);
      node.dataset.icon = icon;
      node.title = label;
      node.setAttribute("aria-label", label);
      return node;
    },
    sheetButton: (text: string, className: string, click: (button: ElementStub) => void) => {
      const node = new ElementStub(className);
      node.textContent = text;
      node.addEventListener("click", () => click(node));
      return node;
    },
    openSheet: vi.fn(),
    closeSheet: vi.fn(),
    store: { state: { project: PROJECT, tabs: [], conversations: [], agents: [], primary: "claude" } },
    input: new ElementStub(),
    AGENTS: { claude: { name: "Claude" } },
    wideUsage: new EventTarget(),
    t: (key: string) => key,
    send: vi.fn(async () => true),
    renderQuestionDock: vi.fn(),
    refreshUsage: vi.fn(),
    conversationList: () => [],
    syncTargetButtons: vi.fn(),
    renderPending: vi.fn(),
    refreshOpenSheet: vi.fn(),
    syncPendingButtons: vi.fn(),
  } as unknown as ClientContext;
  vi.stubGlobal("document", { body: { dataset: {} }, querySelectorAll: () => [] });
  return { ctx, get };
}

afterEach(() => vi.unstubAllGlobals());

describe("タブ操作", () => {
  it.each([false, true])("現在の保存済み会話のタブ固定を変更する: %s", tabbed => {
    const { ctx, get } = setup();
    ctx.store.state!.conversations = [conversation(tabbed)];
    ctx.store.state!.tabs = [{ projectRoot: PROJECT, conversationId: "saved", title: "会話", tabbed, current: true }];
    createStateView(ctx).renderState();
    const action = get("#conversation-tabs").children[0]!.children[1]!;
    expect(action.dataset.icon).toBe(tabbed ? "x" : "pin");
    expect(action.title).toBe(tabbed ? "web.conv.closeTab" : "web.conv.keepTab");
    expect(action.getAttribute("aria-label")).toBe(action.title);
    action.dispatchEvent(new Event("click"));
    expect(ctx.send).toHaveBeenCalledWith(`/tab ${tabbed ? "close" : "keep"} saved ${PROJECT}`, action);
  });

  it("未保存の現在の会話には固定操作を出さず、別 project の固定タブは閉じられる", () => {
    const { ctx, get } = setup();
    const otherProject = "C:\\other";
    ctx.store.state!.tabs = [
      { projectRoot: otherProject, conversationId: "other", title: "別の会話", tabbed: true, current: false },
      { projectRoot: PROJECT, conversationId: "new", title: "", tabbed: false, current: true },
    ];
    createStateView(ctx).renderState();
    const [other, current] = get("#conversation-tabs").children;
    expect(current!.children).toHaveLength(1);
    const close = other!.children[1]!;
    close.dispatchEvent(new Event("click"));
    expect(ctx.send).toHaveBeenCalledWith(`/tab close other ${otherProject}`, close);
  });

  it.each([false, true])("会話メニューのタブ操作とピン止めは別のコマンドを送る: %s", async tabbed => {
    const { ctx } = setup();
    createConversationSheets(ctx).openConversationMenu(conversation(tabbed), 2);
    const actions = vi.mocked(ctx.openSheet).mock.calls[0]![1] as unknown as ElementStub[];
    const tab = actions.find(action => action.textContent === (tabbed ? "web.conv.removeTab" : "web.conv.addTab"))!;
    tab.dispatchEvent(new Event("click"));
    expect(ctx.send).toHaveBeenLastCalledWith(`/tab ${tabbed ? "close" : "keep"} saved ${PROJECT}`, tab);
    const pin = actions.find(action => action.textContent === "web.conv.unpin")!;
    pin.dispatchEvent(new Event("click"));
    expect(ctx.send).toHaveBeenLastCalledWith("/pin 2", pin);
    await Promise.resolve();
    expect(ctx.closeSheet).toHaveBeenCalledTimes(2);
  });
});
