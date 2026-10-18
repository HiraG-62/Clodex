import { afterEach, expect, it, vi } from "vitest";
import { createComposer } from "./composer.js";
import { attachmentDraftKey, draftKey } from "./drafts.js";
import type { ClientContext } from "./store.js";

class ComposerNode extends EventTarget {
  value = "";
  disabled = false;
  hidden = false;
  style = {};
  children: ComposerNode[] = [];
  selectionStart = 0;
  selectionEnd = 0;
  classList = { contains: () => false, toggle: () => {} };
  attributes = new Map<string, string>();
  append(...nodes: ComposerNode[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: ComposerNode[]) {
    this.children = nodes;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  getAttribute(key: string) {
    return this.attributes.get(key);
  }
}

function setup(text = "", paths = ["C:/a.png"]) {
  vi.useFakeTimers();
  const nodes = new Map<string, ComposerNode>();
  const get = (selector: string) => {
    let node = nodes.get(selector);
    if (!node) {
      node = new ComposerNode();
      nodes.set(selector, node);
    }
    return node;
  };
  vi.stubGlobal("document", {
    querySelector: get,
    querySelectorAll: () => [],
    createTextNode: () => new ComposerNode(),
  });
  const key = draftKey("C:/work", "a");
  const values = new Map([[attachmentDraftKey(key), JSON.stringify(paths)]]);
  const ctx = {
    $: get,
    input: get("#input"),
    newer: get("#newer"),
    log: get("#log"),
    store: { currentDraftKey: key, liveGeneration: 0, uploading: 0, target: "codex" },
    storage: {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => values.set(key, value),
      remove: (key: string) => values.delete(key),
    },
    mobile: { matches: false },
    commands: [],
    AGENT_IDS: ["claude", "codex"],
    AGENTS: { codex: { name: "Codex" } },
    t: (key: string) => key,
    icon: () => new ComposerNode(),
    mark: () => new ComposerNode(),
    el: () => new ComposerNode(),
    iconButton: () => new ComposerNode(),
    fileUrl: (_api: string, path: string) => path,
    nearBottom: () => false,
    scrollToBottom: vi.fn(),
    send: vi.fn(async () => true),
  } as unknown as ClientContext;
  ctx.input.value = text;
  const composer = createComposer(ctx);
  composer.restoreAttachments();
  return { ctx, composer, get, values, key, submit: () => get("#composer").dispatchEvent(new Event("submit")) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["", "本文"])("添付を末尾に送信し、成功後は本文と添付の下書きを消す: %s", async text => {
  const { ctx, get, values, submit } = setup(text);
  submit();
  expect(ctx.send).toHaveBeenCalledWith(`@codex ${text ? `${text}\n` : ""}@C:/a.png`, get("#composer .send"));
  await Promise.resolve();
  expect(ctx.input.value).toBe("");
  expect(get("#composer-attachments").hidden).toBe(true);
  expect(values.size).toBe(0);
});

it("送信失敗では本文と添付を残す", async () => {
  const { ctx, get, values, key, submit } = setup("本文");
  vi.mocked(ctx.send).mockResolvedValue(false);
  submit();
  await Promise.resolve();
  expect(ctx.input.value).toBe("本文");
  expect(get("#composer-attachments").hidden).toBe(false);
  expect(values.get(attachmentDraftKey(key))).toBe('["C:/a.png"]');
});

it("シェル入力では画像を送らず、添付とその下書きを残す", async () => {
  const { ctx, get, values, key, submit } = setup("!pnpm test");
  submit();
  expect(ctx.send).toHaveBeenCalledWith("!pnpm test", get("#composer .send"));
  await Promise.resolve();
  expect(ctx.input.value).toBe("");
  expect(get("#composer-attachments").hidden).toBe(false);
  expect(values.get(attachmentDraftKey(key))).toBe('["C:/a.png"]');
});

it("画像の保存中は送信しない", () => {
  const { ctx, submit } = setup("本文");
  ctx.store.uploading = 1;
  submit();
  expect(ctx.send).not.toHaveBeenCalled();
});

it("送信中に会話を切り替えた場合は切替先の本文と添付を残す", async () => {
  const { ctx, composer, get, values, key, submit } = setup("本文");
  let complete!: (sent: boolean) => void;
  vi.mocked(ctx.send).mockImplementation(
    () =>
      new Promise<boolean>(resolve => {
        complete = resolve;
      }),
  );
  submit();
  const nextKey = draftKey("C:/work", "b");
  values.set(attachmentDraftKey(nextKey), '["C:/b.png"]');
  ctx.store.currentDraftKey = nextKey;
  ctx.store.liveGeneration++;
  ctx.input.value = "別の本文";
  composer.restoreAttachments();
  complete(true);
  await Promise.resolve();
  expect(ctx.input.value).toBe("別の本文");
  expect(get("#composer-attachments").hidden).toBe(false);
  expect(values.get(attachmentDraftKey(nextKey))).toBe('["C:/b.png"]');
  expect(values.has(attachmentDraftKey(key))).toBe(false);
});
