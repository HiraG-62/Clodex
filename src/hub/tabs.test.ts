import { describe, expect, it } from "vitest";
import { buildTabs } from "./tabs.js";

describe("buildTabs", () => {
  const projects = [
    {
      projectRoot: "C:\\one",
      conversations: [
        { id: "one-pinned", title: "One", pinned: true, activity: "busy" as const },
        { id: "one-other", title: "Other" },
      ],
    },
    {
      projectRoot: "C:\\two",
      conversations: [
        { id: "two-pinned", title: "Two", pinned: true },
        { id: "two-other", title: "Hidden" },
      ],
    },
  ];

  it("プロジェクトと会話の順に固定した会話を並べ、今の会話を末尾に足す", () => {
    expect(buildTabs(projects, { projectRoot: "C:\\one", conversation: { id: "one-other", title: "Other" } })).toEqual([
      { projectRoot: "C:\\one", conversationId: "one-pinned", title: "One", pinned: true, current: false, activity: "busy" },
      { projectRoot: "C:\\two", conversationId: "two-pinned", title: "Two", pinned: true, current: false },
      { projectRoot: "C:\\one", conversationId: "one-other", title: "Other", pinned: false, current: true },
    ]);
  });

  it("今の会話が固定済みなら重複させず、選択状態にする", () => {
    expect(buildTabs(projects, { projectRoot: "C:\\one", conversation: { id: "one-pinned", title: "One", pinned: true, activity: "busy" } })).toMatchObject([
      { conversationId: "one-pinned", current: true },
      { conversationId: "two-pinned", current: false },
    ]);
    expect(buildTabs(projects)).toHaveLength(2);
  });
});
