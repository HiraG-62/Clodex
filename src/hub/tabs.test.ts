import { describe, expect, it } from "vitest";
import { buildTabs } from "./tabs.js";

describe("buildTabs", () => {
  const projects = [
    {
      projectRoot: "C:\\one",
      conversations: [
        { id: "one-tabbed", title: "One", tabbed: true, activity: "busy" as const },
        { id: "one-other", title: "Other" },
      ],
    },
    {
      projectRoot: "C:\\two",
      conversations: [
        { id: "two-tabbed", title: "Two", tabbed: true },
        { id: "two-other", title: "Hidden", pinned: true, tabbed: false },
      ],
    },
  ];

  it("プロジェクトと会話の順に固定した会話を並べ、今の会話を末尾に足す", () => {
    expect(buildTabs(projects, { projectRoot: "C:\\one", conversation: { id: "one-other", title: "Other" } })).toEqual([
      { projectRoot: "C:\\one", conversationId: "one-tabbed", title: "One", tabbed: true, current: false, activity: "busy" },
      { projectRoot: "C:\\two", conversationId: "two-tabbed", title: "Two", tabbed: true, current: false },
      { projectRoot: "C:\\one", conversationId: "one-other", title: "Other", tabbed: false, current: true },
    ]);
  });

  it("今の会話が固定済みなら重複させず、選択状態にする", () => {
    expect(buildTabs(projects, { projectRoot: "C:\\one", conversation: { id: "one-tabbed", title: "One", tabbed: true, activity: "busy" } })).toMatchObject([
      { conversationId: "one-tabbed", current: true },
      { conversationId: "two-tabbed", current: false },
    ]);
    expect(buildTabs(projects)).toHaveLength(2);
  });
  it("子のタブには親の会話名を入れる", () => {
    const tabs = buildTabs(
      [
        {
          projectRoot: "C:\\one",
          conversations: [
            { id: "parent", title: "親" },
            { id: "child", title: "作業（並列）", tabbed: true, parent: { conversationId: "parent" } },
          ],
        },
      ],
      { projectRoot: "C:\\one", conversation: { id: "child", title: "作業（並列）", parent: { conversationId: "parent" } } },
    );
    expect(tabs[0]).toMatchObject({ conversationId: "child", parentTitle: "親" });
    expect(
      buildTabs(
        [
          {
            projectRoot: "C:\\one",
            conversations: [
              { id: "parent", title: "親" },
              { id: "child", tabbed: true, parent: { conversationId: "parent" } },
            ],
          },
        ],
        { projectRoot: "C:\\one", conversation: { id: "parent", title: "親" } },
      ).map(tab => tab.conversationId),
    ).toEqual(["parent"]);
  });
});
