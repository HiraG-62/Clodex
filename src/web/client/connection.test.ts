import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection, tokenExpired } from "./connection.js";
import type { ClientContext } from "./store.js";
import { selectTarget, targetKey } from "./targets.js";

afterEach(() => vi.unstubAllGlobals());

it("state の会話切り替えと再接続で送り先を復元し、削除済み会話の保存値を掃除する", async () => {
  let receive: ((event: { data: string }) => void) | undefined;
  vi.stubGlobal(
    "EventSource",
    class {
      set onmessage(handler: (event: { data: string }) => void) {
        receive = handler;
      }
    },
  );
  vi.stubGlobal("document", { visibilityState: "visible" });
  const node = { addEventListener: vi.fn(), classList: { remove: vi.fn() }, setAttribute: vi.fn() };
  const values = new Map<string, string>();
  const ctx = {
    $: () => node,
    store: { liveGeneration: 0, startingAt: new Map(), settingRequests: new Map(), interrupting: new Set(), fileSet: new Set() },
    input: { value: "" },
    storage: {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => values.set(key, value),
      remove: (key: string) => values.delete(key),
      keys: () => [...values.keys()],
    },
    closeUsage: vi.fn(),
    closeSheet: vi.fn(),
    saveDraft: vi.fn(),
    restoreAttachments: vi.fn(),
    onInputChanged: vi.fn(),
    renderState: vi.fn(),
    renderLog: vi.fn(),
  } as unknown as ClientContext;
  createConnection(ctx);
  await new Promise(resolve => setImmediate(resolve));
  const effectiveTarget = () => ctx.store.target ?? ctx.store.state?.primary;
  const switchTo = (id: string, ids = ["a", "b", "c"], solo?: string) => {
    receive?.({
      data: JSON.stringify({
        type: "state",
        state: {
          project: "C:/work",
          primary: "claude",
          projects: [{ projectRoot: "C:/work", current: true }],
          conversations: ids.map(entry => ({ id: entry, current: entry === id, solo: entry === id ? solo : undefined })),
          agents: [],
        },
      }),
    });
  };
  switchTo("a");
  expect(effectiveTarget()).toBe("claude");
  selectTarget(ctx, "codex");
  switchTo("b");
  expect(effectiveTarget()).toBe("claude");
  selectTarget(ctx, "gemini");
  switchTo("a");
  expect(ctx.store.target).toBe("codex");
  switchTo("b");
  expect(ctx.store.target).toBe("gemini");
  ctx.store.state = undefined;
  switchTo("a");
  expect(ctx.store.target).toBe("codex");
  switchTo("b", undefined, "claude");
  expect(ctx.store.target).toBe("claude");
  selectTarget(ctx, "claude");
  expect(values.get(targetKey("C:/work", "b"))).toBe("gemini");
  values.set(targetKey("C:/work", "c"), "invalid");
  switchTo("c");
  expect(effectiveTarget()).toBe("claude");
  expect(values.has(targetKey("C:/work", "c"))).toBe(false);
  switchTo("a", ["a"]);
  expect(values.has(targetKey("C:/work", "b"))).toBe(false);
});

describe("tokenExpired", () => {
  it("401 だけを token の失効と判定する", async () => {
    expect(await tokenExpired(vi.fn(async () => new Response(null, { status: 401 })))).toBe(true);
    expect(await tokenExpired(vi.fn(async () => new Response(null, { status: 503 })))).toBe(false);
  });

  it("接続失敗は token の失効と決めつけない", async () => {
    expect(await tokenExpired(vi.fn(async () => Promise.reject(new Error("offline"))))).toBe(false);
  });
});
