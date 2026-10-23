import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentStrip, isCollapsedAgent, nextExpandedAgent, usageRingAlert, usageRingLabel } from "./agent-strip.js";
import type { ClientContext } from "./store.js";

afterEach(() => vi.unstubAllGlobals());

describe("PC Agent ストリップ", () => {
  it("停止中で送り先でも手動展開でもない Agent だけ畳む", () => {
    expect(isCollapsedAgent("stopped", false, false)).toBe(true);
    expect(isCollapsedAgent("stopped", true, false)).toBe(false);
    expect(isCollapsedAgent("stopped", false, true)).toBe(false);
    for (const status of ["busy", "idle", "starting"] as const) {
      expect(isCollapsedAgent(status, false, false)).toBe(false);
    }
  });

  it("タイルの操作で手動展開を切り替える", () => {
    expect(nextExpandedAgent(undefined, "gemini")).toBe("gemini");
    expect(nextExpandedAgent("gemini", "gemini")).toBeUndefined();
  });

  it("円環の代替テキストに利用率と reset を含め、無値はダッシュを示す", () => {
    expect(usageRingLabel("5 時間", 34, "14:00")).toBe("5 時間 34% · reset 14:00");
    expect(usageRingLabel("週", undefined, "")).toBe("週 —");
  });

  it("既定の警告閾値でリング色を切り替える", () => {
    expect(usageRingAlert("fiveHour", 89)).toBe(false);
    expect(usageRingAlert("fiveHour", 90)).toBe(true);
    expect(usageRingAlert("weekly", 14)).toBe(false);
    expect(usageRingAlert("weekly", 15)).toBe(true);
    expect(usageRingAlert("weekly", undefined)).toBe(false);
  });

  it("円環から利用状況を開き、再クリックで閉じる。広い画面では開かない", () => {
    vi.stubGlobal("document", { addEventListener: vi.fn(), querySelectorAll: () => [] });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    const popover = { hidden: true };
    const wideUsage = { matches: false };
    const ctx = {
      $: () => popover,
      store: { usageAgent: undefined },
      wideUsage,
      mobile: { addEventListener: vi.fn() },
      refreshUsage: vi.fn(),
    } as unknown as ClientContext;
    const strip = createAgentStrip(ctx);
    Object.assign(ctx, strip);
    ctx.refreshUsage = vi.fn();
    strip.toggleUsage("claude");
    expect(ctx.store.usageAgent).toBe("claude");
    expect(ctx.refreshUsage).toHaveBeenCalledOnce();
    strip.toggleUsage("claude");
    expect(ctx.store.usageAgent).toBeUndefined();
    wideUsage.matches = true;
    strip.toggleUsage("claude");
    expect(ctx.store.usageAgent).toBeUndefined();
  });
});
