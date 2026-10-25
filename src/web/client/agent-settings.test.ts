import { describe, expect, it, vi } from "vitest";
import type { AgentId } from "../../agents/agent-adapter.js";
import { AGENT_META } from "../../agents/agent-meta.js";
import { createAgentSettings } from "./agent-settings.js";
import type { ClientContext } from "./store.js";

class ElementStub extends EventTarget {
  children: ElementStub[] = [];
  dataset: Record<string, string> = {};
  value = "";
  hidden = false;
  textContent = "";
  append(...nodes: ElementStub[]) {
    this.children.push(...nodes);
  }
  setAttribute() {}
  focus() {}
}

const settingsFor = (id: AgentId) => {
  const openSheet = vi.fn();
  const ctx = {
    store: {
      state: {
        agents: [{ id, permission: "edit", models: [], effort: "high" }],
        roles: { [id]: "" },
        rules: { [id]: [] },
        roleSources: {},
      },
    },
    displayedAgent: (agent: unknown) => agent,
    displayDefault: (value: string | undefined) => value ?? "default",
    el: (_tag: string, _className?: string, text = "") => {
      const node = new ElementStub();
      node.textContent = text;
      return node;
    },
    t: (key: string) => key,
    AGENTS: { [id]: { name: AGENT_META[id].name } },
    PERMISSIONS: ["read-only", "edit", "full"],
    EFFORTS: { [id]: AGENT_META[id].effortLevels },
    sheetButton: () => new ElementStub(),
    openSheet,
    refreshOpenSheet: vi.fn(),
  } as unknown as ClientContext;
  createAgentSettings(ctx).openAgentSettings(id);
  return openSheet.mock.calls[0]?.[1] as ElementStub[];
};

describe("Agent 設定", () => {
  it("effort を持たない Gemini に effort 行を出さない", () => {
    const nodes = settingsFor("gemini");
    expect(nodes.some(node => node.children.some(child => child.textContent === "web.agentSettings.effort"))).toBe(false);
  });

  it("Claude に effort 行を出す", () => {
    const nodes = settingsFor("claude");
    expect(nodes.some(node => node.children.some(child => child.textContent === "web.agentSettings.effort"))).toBe(true);
  });
});
