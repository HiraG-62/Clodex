import { attachmentDraftKey, readAttachmentDraft, saveAttachmentDraft } from "./drafts.js";
import { isShellInput } from "./shell-input.js";
import type { ClientContext } from "./store.js";

interface Attachment {
  path?: string;
  objectUrl?: string;
}

export function composeAttachmentText(text: string, paths: readonly string[]): string {
  const body = text.trim();
  if (isShellInput(body) || !paths.length) return body;
  return [body, paths.map(path => `@${path}`).join(" ")].filter(Boolean).join("\n");
}

export function canSubmitAttachments(text: string, paths: readonly string[], uploading: number): boolean {
  return uploading === 0 && Boolean(composeAttachmentText(text, paths));
}

export function createComposerAttachments(ctx: ClientContext) {
  let entries: Attachment[] = [];
  const list = ctx.$("#composer-attachments");
  const sendButton = ctx.$<HTMLButtonElement>("#composer .send");
  const paths = () => entries.flatMap(entry => (entry.path ? [entry.path] : []));
  const release = (entry: Attachment) => {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  };
  const persist = () => {
    if (ctx.store.currentDraftKey) saveAttachmentDraft(ctx.storage, ctx.store.currentDraftKey, paths());
  };
  const remove = (entry: Attachment) => {
    if (!entries.includes(entry)) return;
    entries = entries.filter(item => item !== entry);
    release(entry);
    persist();
    render();
  };
  const render = () => {
    list.hidden = entries.length === 0;
    list.replaceChildren(
      ...entries.map(entry => {
        const tile = ctx.el("div", "composer-attachment");
        const preview = ctx.el("button", "attachment-preview") as HTMLButtonElement;
        preview.type = "button";
        preview.disabled = !entry.path;
        preview.setAttribute("aria-label", ctx.t("web.image.title"));
        const image = ctx.el("img") as HTMLImageElement;
        image.alt = "";
        image.src = entry.objectUrl ?? ctx.fileUrl("file", entry.path!);
        preview.append(image);
        preview.addEventListener("click", () => {
          if (entry.path) ctx.openImage(entry.path);
        });
        if (!entry.path) {
          const loading = ctx.el("span", "attachment-loading");
          loading.append(ctx.el("span", "spin"));
          preview.append(loading);
        }
        const close = ctx.iconButton("x", ctx.t("web.attach.remove"), "attachment-remove");
        close.addEventListener("click", () => remove(entry));
        tile.append(preview, close);
        return tile;
      }),
    );
  };
  const restoreAttachments = () => {
    entries.forEach(release);
    entries = ctx.store.currentDraftKey ? readAttachmentDraft(ctx.storage, ctx.store.currentDraftKey).map(path => ({ path })) : [];
    render();
  };
  const clearSubmitted = (submitted: readonly string[], draftKey: string | undefined) => {
    if (draftKey !== ctx.store.currentDraftKey) {
      if (draftKey) ctx.storage.remove(attachmentDraftKey(draftKey));
      return;
    }
    const sent = new Set(submitted);
    for (const entry of entries) {
      if (entry.path && sent.has(entry.path)) release(entry);
    }
    entries = entries.filter(entry => !entry.path || !sent.has(entry.path));
    persist();
    render();
  };
  const attach = async (file: Blob) => {
    const generation = ctx.store.liveGeneration;
    const entry: Attachment = { objectUrl: URL.createObjectURL(file) };
    entries.push(entry);
    ctx.store.uploading++;
    sendButton.disabled = true;
    render();
    try {
      const response = await fetch("/api/upload", { method: "POST", headers: { "content-type": file.type }, body: file });
      if (!response.ok) throw new Error(String(response.status));
      const { path } = (await response.json()) as { path: string };
      if (generation !== ctx.store.liveGeneration || !entries.includes(entry)) return;
      entry.path = path;
      persist();
      render();
    } catch {
      remove(entry);
      ctx.showToast(ctx.t("web.upload.failed"));
    } finally {
      ctx.store.uploading--;
      sendButton.disabled = ctx.store.uploading > 0 || sendButton.classList.contains("is-loading");
    }
  };
  return { paths, attach, restoreAttachments, clearSubmitted };
}
