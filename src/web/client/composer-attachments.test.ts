import { afterEach, describe, expect, it, vi } from "vitest";
import { canSubmitAttachments, composeAttachmentText, createComposerAttachments } from "./composer-attachments.js";
import { attachmentDraftKey, draftKey } from "./drafts.js";
import type { ClientContext } from "./store.js";

describe("添付の送信", () => {
  it.each([
    ["  本文  ", ["a.png", "b.png"], "本文\n@a.png @b.png"],
    ["  ", ["a.png"], "@a.png"],
    [" 本文 ", [], "本文"],
    ["!pnpm test", ["a.png"], "!pnpm test"],
    ["!> pnpm test", ["a.png"], "!> pnpm test"],
  ])("本文と添付を組み立てる: %s", (text, paths, expected) => {
    expect(composeAttachmentText(text, paths)).toBe(expected);
  });
  it("添付だけで送信でき、保存中は送信しない", () => {
    expect(canSubmitAttachments("", ["a.png"], 0)).toBe(true);
    expect(canSubmitAttachments("", [], 0)).toBe(false);
    expect(canSubmitAttachments("本文", ["a.png"], 1)).toBe(false);
  });
});

class TestNode {
  children: TestNode[] = [];
  hidden = false;
  disabled = false;
  src = "";
  listeners = new Map<string, () => void>();
  classList = { contains: () => false };
  constructor(
    public tag = "div",
    public className = "",
  ) {}
  append(...nodes: TestNode[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: TestNode[]) {
    this.children = nodes;
  }
  addEventListener(event: string, action: () => void) {
    this.listeners.set(event, action);
  }
  setAttribute() {}
  click() {
    this.listeners.get("click")?.();
  }
}

function setup() {
  const list = new TestNode();
  const send = new TestNode("button");
  const values = new Map<string, string>();
  const storage = {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => values.set(key, value),
    remove: (key: string) => values.delete(key),
  };
  const ctx = {
    store: { uploading: 0, liveGeneration: 0, currentDraftKey: draftKey("C:/work", "a") },
    storage,
    $: (selector: string) => (selector === "#composer-attachments" ? list : send),
    el: (tag: string, cls?: string) => new TestNode(tag, cls),
    iconButton: (_icon: string, _label: string, cls: string) => new TestNode("button", cls),
    t: (key: string) => key,
    showToast: vi.fn(),
    openImage: vi.fn(),
    fileUrl: (_api: string, path: string) => `/api/file?path=${encodeURIComponent(path)}`,
  } as unknown as ClientContext;
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const attachments = createComposerAttachments(ctx);
  return { ctx, attachments, list, send, values, revoke };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("添付の操作", () => {
  it("保存中の画像とスピナーを表示し、保存後は開く・削除できる", async () => {
    const { ctx, attachments, list, send, values, revoke } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ path: "C:/a.png" })),
    );
    const upload = attachments.attach(new Blob(["image"], { type: "image/png" }));
    expect(send.disabled).toBe(true);
    expect(list.hidden).toBe(false);
    expect(list.children[0]?.children[0]?.children[0]?.src).toBe("blob:preview");
    expect(list.children[0]?.children[0]?.children[1]?.className).toBe("attachment-loading");
    await upload;
    expect(send.disabled).toBe(false);
    expect(attachments.paths()).toEqual(["C:/a.png"]);
    expect(values.get(attachmentDraftKey(ctx.store.currentDraftKey!))).toBe('["C:/a.png"]');
    list.children[0]?.children[0]?.click();
    expect(ctx.openImage).toHaveBeenCalledWith("C:/a.png");
    list.children[0]?.children[1]?.click();
    expect(attachments.paths()).toEqual([]);
    expect(list.hidden).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:preview");
  });

  it("保存中に外した画像は完了しても戻さない", async () => {
    const { attachments, list, revoke } = setup();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>(resolve => {
          finish = resolve;
        }),
    );
    const upload = attachments.attach(new Blob());
    list.children[0]?.children[1]?.click();
    finish(Response.json({ path: "C:/a.png" }));
    await upload;
    expect(attachments.paths()).toEqual([]);
    expect(list.hidden).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it.each(["http", "network"])("保存失敗で画像を外して通知する: %s", async failure => {
    const { ctx, attachments, list, revoke } = setup();
    vi.stubGlobal("fetch", async () => {
      if (failure === "network") throw new Error("offline");
      return new Response(null, { status: 500 });
    });
    await attachments.attach(new Blob());
    expect(list.hidden).toBe(true);
    expect(ctx.showToast).toHaveBeenCalledWith("web.upload.failed");
    expect(ctx.store.uploading).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("会話切替後の保存完了を破棄し、新しい会話の下書きを復元する", async () => {
    const { ctx, attachments, list, values, revoke } = setup();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>(resolve => {
          finish = resolve;
        }),
    );
    const upload = attachments.attach(new Blob());
    ctx.store.liveGeneration++;
    ctx.store.currentDraftKey = draftKey("C:/work", "b");
    values.set(attachmentDraftKey(ctx.store.currentDraftKey), '["C:/b.png"]');
    attachments.restoreAttachments();
    finish(Response.json({ path: "C:/a.png" }));
    await upload;
    expect(attachments.paths()).toEqual(["C:/b.png"]);
    expect(list.children[0]?.children[0]?.children[0]?.src).toBe("/api/file?path=C%3A%2Fb.png");
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("送信した添付だけを消し、新たに付けた画像は残す", async () => {
    const { ctx, attachments, revoke } = setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ path: "a.png" }))
        .mockResolvedValueOnce(Response.json({ path: "b.png" })),
    );
    await attachments.attach(new Blob());
    const submitted = attachments.paths();
    await attachments.attach(new Blob());
    attachments.clearSubmitted(submitted, ctx.store.currentDraftKey);
    expect(attachments.paths()).toEqual(["b.png"]);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
