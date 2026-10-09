import { describe, expect, it, vi } from "vitest";
import { connectConversationFeed } from "./conversation-feed.js";

describe("connectConversationFeed", () => {
  it("初期会話と切り替え先の feed を読み込み、保存対象外を prune する", () => {
    let switchTo: ((id: string) => void) | undefined;
    let removed: ((id: string) => void) | undefined;
    const history = {
      currentId: "current",
      list: () => [{ id: "old" }],
      onSwitch: (listener: (id: string) => void) => {
        switchTo = listener;
      },
      onRemove: (listener: (id: string) => void) => {
        removed = listener;
      },
    };
    const store = {
      prune: vi.fn(),
      load: vi.fn((id: string) => [{ type: "output" as const, seq: 1, text: id }]),
    };
    const feed = { replace: vi.fn() };
    const working = new Set<"claude" | "codex">(["codex"]);
    connectConversationFeed(history, store, feed, id => (id === "old" ? working : new Set()));
    expect(store.load).toHaveBeenCalledWith("current", new Set());
    expect(store.prune).toHaveBeenCalledWith(["current", "old"]);
    expect(feed.replace).toHaveBeenCalledWith([{ type: "output", seq: 1, text: "current" }]);
    switchTo?.("old");
    expect(store.load).toHaveBeenLastCalledWith("old", working);
    expect(store.prune).toHaveBeenLastCalledWith(["old", "old"]);
    expect(feed.replace).toHaveBeenLastCalledWith([{ type: "output", seq: 1, text: "old" }]);
    // 会話を削除したら、その feed も消す（今の会話は old のまま）
    history.list = () => [];
    removed?.("other");
    expect(store.prune).toHaveBeenLastCalledWith(["current"]);
  });
});
