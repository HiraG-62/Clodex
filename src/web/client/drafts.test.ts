import { describe, expect, it } from "vitest";
import { attachmentDraftKey, draftKey, readAttachmentDraft, saveAttachmentDraft, staleDraftKeys } from "./drafts.js";

describe("draftKey", () => {
  it("project root と会話 ID を区切りと衝突しない鍵にする", () => {
    expect(draftKey("C:\\work:a", "b:c")).toBe("clodex.draft:C%3A%5Cwork%3Aa:b%3Ac");
    expect(draftKey("C:\\work:a:b", "c")).not.toBe(draftKey("C:\\work:a", "b:c"));
  });
});

describe("添付の下書き", () => {
  it("本文と対になる鍵に保存し、復元する", () => {
    const values = new Map<string, string>();
    const storage = {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => values.set(key, value),
      remove: (key: string) => values.delete(key),
    };
    const key = draftKey("C:/work", "a");
    const paths = ["C:/uploads/a.png", "C:/uploads/b.png"];
    saveAttachmentDraft(storage, key, paths);
    expect(values.get(attachmentDraftKey(key))).toBe(JSON.stringify(paths));
    expect(readAttachmentDraft(storage, key)).toEqual(paths);
    expect(readAttachmentDraft(storage, draftKey("C:/work", "b"))).toEqual([]);
    saveAttachmentDraft(storage, key, []);
    expect(values.size).toBe(0);
  });

  it.each([null, "invalid", "{}", '[1,"a.png"]'])("壊れた保存内容は復元しない: %s", value => {
    expect(readAttachmentDraft({ get: () => value }, "key")).toEqual([]);
  });

  it("古い添付だけを本文と一緒に掃除する", () => {
    const active = draftKey("C:/work", "a");
    const deleted = draftKey("C:/work", "b");
    const other = draftKey("C:/other", "b");
    const keys = [active, attachmentDraftKey(active), deleted, attachmentDraftKey(deleted), attachmentDraftKey(other)];
    expect(staleDraftKeys(keys, "C:/work", ["a"])).toEqual([deleted, attachmentDraftKey(deleted)]);
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
