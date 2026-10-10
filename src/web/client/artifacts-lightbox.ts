import { type Artifact, classifyDiffLine, collectArtifacts, displayPath } from "./artifacts.js";
import { fitView, zoomView } from "./image-zoom.js";
import { renderMarkdown } from "./markdown.js";
import { hasNewShared, sharedOpenedKey } from "./shared-unread.js";
import type { ClientContext } from "./store.js";

export function createArtifactsLightbox(ctx: ClientContext) {
  // ---- 成果物（DESIGN.md §28 v0.3 B） ----
  // version: 同じパスの画像が書き換わっても、メッセージごとに別の URL にして古い画像を使い回させない
  const fileUrl = (api: "file" | "diff", path: string, version?: string) =>
    `/api/${api}?path=${encodeURIComponent(path)}${version ? `&v=${encodeURIComponent(version)}` : ""}`;
  const currentSharedKey = () => {
    const state = ctx.store.state;
    const conversation = state?.conversations.find(entry => entry.current);
    return state && conversation ? sharedOpenedKey(state.project, conversation.id) : undefined;
  };
  const sheetRows = (group: Artifact["group"]): HTMLElement[] => {
    const artifacts = collectArtifacts(ctx.store.items).filter(artifact => artifact.group === group);
    const rows: HTMLElement[] = [];
    for (const artifact of artifacts) {
      const row = ctx.el("button", "artifact") as HTMLButtonElement;
      row.type = "button";
      row.append(
        ctx.el("span", `kind ${artifact.kind}`, ctx.t(ctx.ARTIFACT_LABEL[artifact.kind])),
        ctx.el("span", "path mono", displayPath(artifact.path, ctx.store.state?.project ?? "")),
      );
      row.addEventListener("click", () => void openViewer(artifact.path, artifact, group));
      rows.push(row);
    }
    return rows.length ? rows : [ctx.el("p", "muted small", ctx.t("web.artifacts.empty"))];
  };
  const syncSharedUnread = () => {
    const key = currentSharedKey();
    const unread = hasNewShared(collectArtifacts(ctx.store.items), key ? ctx.storage.get(key) : null);
    for (const selector of ["#open-shared", "#mobile-more", "#mobile-open-shared"]) {
      document.querySelector(selector)?.classList.toggle("shared-new", unread);
    }
    if (ctx.sheet.hidden) return;
    if (ctx.store.sheetKind === "shared") {
      if (key) ctx.storage.set(key, new Date().toISOString());
      ctx.$("#sheet-body").replaceChildren(...sheetRows("presented"));
      for (const selector of ["#open-shared", "#mobile-more", "#mobile-open-shared"]) document.querySelector(selector)?.classList.remove("shared-new");
    }
    if (ctx.store.sheetKind === "artifacts") ctx.$("#sheet-body").replaceChildren(...sheetRows("work"));
  };
  const openArtifactSheet = (group: Artifact["group"]) => {
    ctx.store.sheetKind = group === "presented" ? "shared" : "artifacts";
    ctx.store.sheetAgent = undefined;
    if (group === "presented") {
      const key = currentSharedKey();
      if (key) ctx.storage.set(key, new Date().toISOString());
    }
    ctx.openSheet(ctx.t(group === "presented" ? "web.top.shared" : "web.artifacts.title"), sheetRows(group));
    syncSharedUnread();
  };
  const openShared = () => openArtifactSheet("presented");
  const openArtifacts = () => openArtifactSheet("work");
  // ---- 画像のビューア（DESIGN.md §28 成果物）: 全画面で拡大縮小・移動する ----
  const lightbox = ctx.$("#lightbox");
  let lightboxReturnFocus: HTMLElement | undefined;
  const lbStage = ctx.$("#lb-stage");
  const lbImage = ctx.$("#lb-image") as HTMLImageElement;
  const LB_STEP = 1.25;
  const LB_WHEEL_RATE = 0.0015;
  const LB_DRAG_THRESHOLD = 3;
  const LB_DOUBLE_TAP_MS = 300;
  let lbView = { scale: 1, x: 0, y: 0 };
  let lbFitScale = 1;
  const lbPointers = new Map<number, { x: number; y: number }>();
  let lbPinch: { distance: number; view: typeof lbView } | undefined;
  let lbMoved = false;
  let lbLastTap = 0;
  const lbLocal = (event: { clientX: number; clientY: number }) => {
    const rect = lbStage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const lbCenter = () => ({ x: lbStage.clientWidth / 2, y: lbStage.clientHeight / 2 });
  const applyImageView = (view: typeof lbView) => {
    lbView = view;
    lbImage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    ctx.$("#lb-scale").textContent = `${Math.round(view.scale * 100)}%`;
  };
  const fitImage = () => {
    if (!lbImage.naturalWidth) return;
    const view = fitView({ width: lbImage.naturalWidth, height: lbImage.naturalHeight }, { width: lbStage.clientWidth, height: lbStage.clientHeight });
    lbFitScale = view.scale;
    applyImageView(view);
  };
  const zoomImage = (factor: number, point = lbCenter()) => applyImageView(zoomView(lbView, factor, point));
  // 全体表示と等倍を切り替える（全体表示が等倍なら等倍のまま）
  const toggleActualSize = (point = lbCenter()) => {
    if (Math.abs(lbView.scale - 1) < 0.01 && lbFitScale < 1) fitImage();
    else zoomImage(1 / lbView.scale, point);
  };
  const openImage = (path: string, version?: string) => {
    if (lightbox.hidden) lightboxReturnFocus = ctx.rememberFocus();
    const shown = displayPath(path, ctx.store.state?.project ?? "");
    ctx.$("#lb-name").textContent = shown.split(/[/]/).at(-1) ?? shown;
    ctx.$("#lb-name").title = path;
    (ctx.$("#lb-open") as HTMLAnchorElement).href = fileUrl("file", path, version);
    lbImage.alt = shown;
    lbImage.style.transform = "";
    lbImage.onload = fitImage;
    lbImage.src = fileUrl("file", path, version);
    lightbox.hidden = false;
    ctx.$("#lb-close").focus();
  };
  const closeImage = () => {
    lightbox.hidden = true;
    lbImage.removeAttribute("src");
    ctx.restoreFocus(lightboxReturnFocus);
    lightboxReturnFocus = undefined;
  };
  ctx.$("#lb-close").addEventListener("click", closeImage);
  ctx.$("#lb-zoom-in").addEventListener("click", () => zoomImage(LB_STEP));
  ctx.$("#lb-zoom-out").addEventListener("click", () => zoomImage(1 / LB_STEP));
  ctx.$("#lb-fit").addEventListener("click", fitImage);
  ctx.$("#lb-scale").addEventListener("click", () => toggleActualSize());
  lbStage.addEventListener(
    "wheel",
    event => {
      event.preventDefault();
      zoomImage(Math.exp(-event.deltaY * LB_WHEEL_RATE), lbLocal(event));
    },
    { passive: false },
  );
  lbStage.addEventListener("pointerdown", event => {
    // 画面の外へドラッグしても移動を続ける。捕まえられないポインターでも操作は続ける
    try {
      lbStage.setPointerCapture(event.pointerId);
    } catch {
      /* 捕まえなくても動く */
    }
    lbPointers.set(event.pointerId, lbLocal(event));
    if (lbPointers.size === 1) lbMoved = false;
    if (lbPointers.size === 2) {
      const [a, b] = [...lbPointers.values()];
      lbPinch = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, view: lbView };
    }
    lbStage.classList.add("dragging");
  });
  lbStage.addEventListener("pointermove", event => {
    const previous = lbPointers.get(event.pointerId);
    if (!previous) return;
    const now = lbLocal(event);
    lbPointers.set(event.pointerId, now);
    if (lbPointers.size === 2 && lbPinch) {
      const [a, b] = [...lbPointers.values()];
      const middle = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      lbMoved = true;
      return applyImageView(zoomView(lbPinch.view, Math.hypot(a!.x - b!.x, a!.y - b!.y) / lbPinch.distance, middle));
    }
    const dx = now.x - previous.x;
    const dy = now.y - previous.y;
    if (Math.abs(dx) + Math.abs(dy) >= LB_DRAG_THRESHOLD) lbMoved = true;
    applyImageView({ ...lbView, x: lbView.x + dx, y: lbView.y + dy });
  });
  const releasePointer = (event: PointerEvent) => {
    const point = lbLocal(event);
    lbPointers.delete(event.pointerId);
    if (lbPointers.size < 2) lbPinch = undefined;
    if (lbPointers.size) return;
    lbStage.classList.remove("dragging");
    if (lbMoved || event.type === "pointercancel") return;
    // ダブルクリック・ダブルタップで全体と等倍を切り替え、背景の 1 回のクリックで閉じる
    const now = Date.now();
    if (now - lbLastTap < LB_DOUBLE_TAP_MS) {
      lbLastTap = 0;
      return toggleActualSize(point);
    }
    lbLastTap = now;
    if (event.target === lbStage)
      setTimeout(() => {
        if (lbLastTap === now) closeImage();
      }, LB_DOUBLE_TAP_MS);
  };
  lbStage.addEventListener("pointerup", releasePointer);
  lbStage.addEventListener("pointercancel", releasePointer);
  window.addEventListener("resize", () => {
    if (!lightbox.hidden) fitImage();
  });
  document.addEventListener(
    "keydown",
    event => {
      if (lightbox.hidden) return;
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        return closeImage();
      }
      if (event.key === "Tab") {
        event.stopImmediatePropagation();
        return ctx.trapTab(event, lightbox);
      }
      if (event.key === "+" || event.key === "=") return zoomImage(LB_STEP);
      if (event.key === "-") return zoomImage(1 / LB_STEP);
      if (event.key === "0") return fitImage();
    },
    true,
  );

  const openViewer = async (path: string, artifact?: Artifact, returnGroup?: Artifact["group"]) => {
    if (/\.(png|jpe?g|gif|webp)$/i.test(path)) return openImage(path);
    ctx.store.sheetKind = "viewer";
    ctx.store.sheetAgent = undefined;
    const view = ctx.el("div", "viewer");
    const show = async (api: "file" | "diff") => {
      view.replaceChildren(ctx.el("p", "muted small", ctx.t("web.viewer.loading")));
      try {
        const url = api === "diff" && artifact?.changed ? `${fileUrl(api, path)}&since=${encodeURIComponent(artifact.firstAt)}` : fileUrl(api, path);
        const response = await fetch(url);
        const text = await response.text();
        if (!response.ok) return view.replaceChildren(ctx.el("p", "muted small", text || ctx.t("web.viewer.failedStatus", { status: response.status })));
        if (api === "diff" && !text) {
          const content = await fetch(fileUrl("file", path));
          const body = await content.text();
          const nodes: HTMLElement[] = [ctx.el("p", "muted small", ctx.t("web.viewer.noDiff"))];
          if (content.ok) nodes.push(ctx.el("pre", "code", body));
          return view.replaceChildren(...nodes);
        }
        if (api === "file" && /\.md$/i.test(path)) {
          const doc = ctx.el("div", "md");
          doc.innerHTML = renderMarkdown(text);
          return view.replaceChildren(doc);
        }
        const pre = ctx.el("pre", api === "diff" ? "code diff" : "code");
        for (const line of text.split("\n")) {
          const cls = api === "diff" ? classifyDiffLine(line) : "";
          pre.append(ctx.el("span", cls, `${line}\n`));
        }
        view.replaceChildren(pre);
      } catch {
        view.replaceChildren(ctx.el("p", "muted small", ctx.t("web.viewer.failed")));
      }
    };
    const tabs = ctx.choice(
      "view",
      ctx.t("web.viewer.view"),
      ["file", "diff"] as const,
      artifact?.changed ? "diff" : "file",
      v => ctx.t(v === "file" ? "web.viewer.whole" : "web.viewer.diff"),
      v => void show(v),
    );
    const back = returnGroup ? ctx.iconButton("arrow-left", ctx.t("web.viewer.back")) : undefined;
    back?.addEventListener("click", () => openArtifactSheet(returnGroup!));
    ctx.openSheet(displayPath(path, ctx.store.state?.project ?? ""), [...(back ? [back] : []), tabs, view]);
    await show(artifact?.changed ? "diff" : "file");
  };
  return { openImage, fileUrl, openViewer, openArtifacts, openShared, syncSharedUnread };
}
