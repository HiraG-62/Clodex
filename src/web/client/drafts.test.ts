import { describe, expect, it } from "vitest";
import { draftKey, staleDraftKeys } from "./drafts.js";

describe("draftKey", () => {
  it("project root と会話 ID を区切りと衝突しない鍵にする", () => {
    expect(draftKey("C:\\work:a", "b:c")).toBe("clodex.draft:C%3A%5Cwork%3Aa:b%3Ac");
    expect(draftKey("C:\\work:a:b", "c")).not.toBe(draftKey("C:\\work:a", "b:c"));
  });
});

describe("staleDraftKeys", () => {
  it("今のプロジェクトで一覧から消えた会話の鍵だけを返す", () => {
    const active = draftKey("C:\\work", "a");
    const deleted = draftKey("C:\\work", "b");
    const other = draftKey("C:\\other", "b");
    expect(staleDraftKeys([active, deleted, other, "clodex-theme"], "C:\\work", ["a"])).toEqual([deleted]);
  });

  it("会話が無くても、別プロジェクトの下書きは残す", () => {
    const current = draftKey("C:\\work:one", "a");
    const other = draftKey("C:\\work", "one:a");
    expect(staleDraftKeys([current, other], "C:\\work:one", [])).toEqual([current]);
  });
});
