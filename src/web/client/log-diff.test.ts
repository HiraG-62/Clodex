import { describe, expect, it } from "vitest";
import { diffTurn, discardMissingOpened, sameWorkingEntry } from "./log-diff.js";
import type { TimelineItem } from "./timeline.js";

const turn = (changes: Partial<Extract<TimelineItem, { kind: "turn" }>> = {}): Extract<TimelineItem, { kind: "turn" }> => ({
  kind: "turn",
  id: "t1",
  agent: "claude",
  at: "2026-10-10T00:00:00Z",
  status: "working",
  steps: [],
  text: "",
  ...changes,
});

describe("diffTurn", () => {
  it("追加ステップと変更ステップだけを返す", () => {
    const previous = turn({
      steps: [
        { kind: "tool", name: "Read", input: "a" },
        { kind: "say", text: "old", at: "a" },
      ],
    });
    const next = turn({
      steps: [
        { kind: "tool", name: "Read", input: "a" },
        { kind: "say", text: "new", at: "a" },
        { kind: "tool", name: "Bash", input: "b" },
      ],
    });
    expect(diffTurn(previous, next)).toMatchObject({ steps: [1, 2], plan: false, body: false });
  });

  it("本文と画像のパスの増減を分ける", () => {
    const previous = turn({ plan: "C:\\a.png C:\\b.png", text: "old" });
    const next = turn({ plan: "C:\\b.png C:\\c.png", text: "new" });
    expect(diffTurn(previous, next)).toMatchObject({ plan: true, body: true, images: { keep: ["C:\\b.png"], add: ["C:\\c.png"], remove: ["C:\\a.png"] } });
  });

  it("画像の順序だけが変わったときも既存要素を使えるようにする", () => {
    const previous = turn({ plan: "a.png b.png" });
    const next = turn({ plan: "b.png a.png" });
    expect(diffTurn(previous, next).images).toMatchObject({ paths: ["b.png", "a.png"], keep: ["b.png", "a.png"], add: [], remove: [], orderChanged: true });
  });
});

it("作業パネルは同じ項目だけを再利用する", () => {
  expect(sameWorkingEntry({ kind: "say", agent: "claude", text: "a" }, { kind: "say", agent: "claude", text: "a" })).toBe(true);
  expect(sameWorkingEntry({ kind: "say", agent: "claude", text: "a" }, { kind: "say", agent: "claude", text: "b" })).toBe(false);
  expect(sameWorkingEntry({ kind: "head", turnId: "t", agent: "claude", at: "a" }, { kind: "head", turnId: "t", agent: "claude", at: "a" })).toBe(true);
});

it("消えた項目の開閉状態を消す", () => {
  const opened = new Map([
    ["keep", true],
    ["old", false],
  ]);
  discardMissingOpened(opened, new Set(["keep"]));
  expect([...opened]).toEqual([["keep", true]]);
});
