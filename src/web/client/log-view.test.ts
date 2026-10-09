import { describe, expect, it, vi } from "vitest";
import { createLogView } from "./log-view.js";
import type { ClientContext } from "./store.js";

class ElementStub {
  children: ElementStub[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  title = "";
  textContent = "";
  innerHTML = "";
  hidden = false;
  constructor(readonly className = "") {}
  append(...nodes: ElementStub[]) {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener() {}
}

describe("createLogView", () => {
  it("届いた割り込みにチェックと読み上げ用の名前を付ける", () => {
    const created: ElementStub[] = [];
    const element = (className = "") => {
      const node = new ElementStub(className);
      created.push(node);
      return node;
    };
    const ctx = {
      $: () => element(),
      el: (_tag: string, className = "", text = "") => {
        const node = element(className);
        node.textContent = text;
        return node;
      },
      icon: (name: string) => element(`icon-${name}`),
      mark: () => element("mark"),
      t: (key: string) => (key === "web.steer.delivered" ? "配達済み" : key),
      clock: () => "00:00",
      AGENTS: { claude: { name: "Claude", mark: "C" }, codex: { name: "Codex", mark: "X" } },
      appendImagePreviews: vi.fn(),
    } as unknown as ClientContext;
    const { renderItem } = createLogView(ctx);
    renderItem({ kind: "human", id: "h1", at: "2026-01-01T00:00:00Z", agent: "claude", text: "修正", steer: true, delivered: true });
    const delivered = created.find(node => node.className === "steer-delivered");
    expect(delivered?.title).toBe("配達済み");
    expect(delivered?.attributes.get("aria-label")).toBe("配達済み");
    expect(delivered?.children.map(node => node.className)).toEqual(["icon-check"]);
    expect(delivered?.textContent).toBe("");
  });
});
