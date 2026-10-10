import { chooseProjectPath } from "./project-picker.js";
import type { ClientContext } from "./store.js";

export function createViewport(ctx: ClientContext) {
  ctx.$("#mobile-menu").addEventListener("click", ctx.openConversations);
  ctx.$("#target-toggle").addEventListener("click", () => {
    ctx.store.target = (ctx.store.target ?? ctx.store.state?.primary ?? "claude") === "claude" ? "codex" : "claude";
    ctx.renderState();
  });
  ctx.$("#mobile-more").addEventListener("click", () => {
    ctx.store.sheetKind = undefined;
    ctx.store.sheetAgent = undefined;
    const actions = ctx.el("div", "mobile-menu-actions");
    for (const [name, key, id] of [
      ["paperclip", "web.top.shared", "open-shared"],
      ["files", "web.top.artifacts", "open-artifacts"],
      ["settings", "web.top.settings", "open-settings"],
      ["list-tree", "web.mobile.detail", "detail"],
      ["folder-open", "web.mobile.openProject", "open-project"],
    ] as const) {
      const button = ctx.iconButton(name, ctx.t(key));
      if (id === "open-shared") {
        button.id = "mobile-open-shared";
        button.classList.toggle("shared-new", ctx.$("#mobile-more").classList.contains("shared-new"));
      }
      button.append(ctx.el("span", "", ctx.t(key)));
      if (id === "detail") button.setAttribute("aria-pressed", String(ctx.store.detail));
      button.addEventListener("click", () => {
        ctx.closeSheet();
        ctx.$(`#${id}`).click();
      });
      actions.append(button);
    }
    const themeButton = ctx.iconButton(ctx.THEME_ICON[ctx.store.theme], "");
    themeButton.id = "mobile-theme";
    ctx.syncThemeButton(themeButton, true);
    themeButton.addEventListener("click", ctx.cycleTheme);
    actions.insertBefore(themeButton, actions.children[2]!);
    const project = ctx.iconButton("folder", ctx.t("web.mobile.project"));
    project.append(ctx.el("span", "", `${ctx.t("web.mobile.project")}: ${ctx.$("#project-name").textContent}`));
    project.addEventListener("click", ctx.openConversations);
    actions.insertBefore(project, actions.lastElementChild);
    ctx.openSheet(ctx.t("web.top.more"), [actions]);
    ctx.sheet.classList.add("mobile-pop");
    actions.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  });
  ctx.$("#mobile-add").addEventListener("click", () => {
    ctx.store.sheetKind = undefined;
    ctx.store.sheetAgent = undefined;
    const actions = ctx.el("div", "mobile-menu-actions");
    for (const [name, key] of [
      ["image-plus", "web.mobile.image"],
      ["terminal", "web.mobile.command"],
    ] as const) {
      const button = ctx.iconButton(name, ctx.t(key));
      button.append(ctx.el("span", "", ctx.t(key)));
      button.addEventListener("click", () => {
        ctx.closeSheet();
        if (name === "image-plus") ctx.$("#attach-file").click();
        else {
          if (!ctx.input.value.startsWith("!")) ctx.input.value = `!${ctx.input.value}`;
          ctx.onInputChanged();
          ctx.input.focus();
        }
      });
      actions.append(button);
    }
    ctx.openSheet(ctx.t("web.mobile.add"), [actions]);
    ctx.sheet.classList.add("mobile-pop", "add-pop");
    actions.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  });
  const tabs = ctx.$(".working-tabs");
  const tabHome = tabs.parentElement!;
  const adaptTabs = () => {
    (ctx.mobile.matches ? ctx.$("#composer") : tabHome).prepend(tabs);
    for (const [id, key] of [["working-toggle", "web.working.title"]] as const) {
      const button = ctx.$(`#${id}`);
      button.querySelector(".mobile-tab-label")?.remove();
      if (ctx.mobile.matches) button.querySelector(".i")?.after(ctx.el("span", "mobile-tab-label", ctx.t(key)));
    }
  };
  ctx.mobile.addEventListener("change", adaptTabs);
  adaptTabs();
  const grab = ctx.$("#sheet-grab");
  let dragStart: number | undefined;
  grab.addEventListener("pointerdown", event => {
    dragStart = event.clientY;
    grab.setPointerCapture(event.pointerId);
  });
  grab.addEventListener("pointerup", event => {
    if (dragStart !== undefined && event.clientY - dragStart >= ctx.SWIPE_CLOSE_PX) ctx.closeSheet();
    dragStart = undefined;
  });
  grab.addEventListener("pointercancel", () => {
    dragStart = undefined;
  });
  const syncViewport = () => {
    const viewport = window.visualViewport;
    const focused = document.activeElement?.matches("input, textarea, select");
    const keyboard = ctx.mobile.matches && focused && viewport && viewport.scale === 1 && window.innerHeight - viewport.height > ctx.KEYBOARD_THRESHOLD_PX;
    document.body.classList.toggle("kbd", Boolean(keyboard));
    const root = document.documentElement.style;
    if (ctx.mobile.matches && viewport?.scale === 1) {
      // iOS はキーボードを出すとページを offsetTop だけスクロールするので、固定した .app を見えている領域に合わせる
      root.setProperty("--viewport-height", `${viewport.height}px`);
      root.setProperty("--viewport-top", `${viewport.offsetTop}px`);
    } else {
      root.removeProperty("--viewport-height");
      root.removeProperty("--viewport-top");
    }
  };
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
  window.addEventListener("resize", syncViewport);
  document.addEventListener("focusin", syncViewport);
  document.addEventListener("focusout", () => requestAnimationFrame(syncViewport));
  syncViewport();
  ctx.$("#sheet-close").addEventListener("click", ctx.closeSheet);
  ctx.$("#sheet-backdrop").addEventListener("click", ctx.closeSheet);
  document.addEventListener("keydown", e => {
    if (ctx.sheet.hidden) return;
    if (e.key === "Escape") ctx.closeSheet();
    ctx.trapTab(e, ctx.sheet.querySelector<HTMLElement>(".sheet-panel")!);
  });
  ctx.$("#open-conversations").addEventListener("click", ctx.openConversations);
  ctx.$("#open-settings").addEventListener("click", ctx.openSettings);
  ctx.$("#new-conversation").addEventListener("click", () => void ctx.send("/new", ctx.$("#new-conversation")));
  ctx.$("#open-artifacts").addEventListener("click", ctx.openArtifacts);
  ctx.$("#open-shared").addEventListener("click", ctx.openShared);
  ctx.$("#projects").addEventListener("change", event => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!value) return;
    const select = event.currentTarget as HTMLSelectElement;
    if (value === ctx.EDIT_PROJECTS_VALUE) {
      select.value = ctx.store.state?.projects?.find(project => project.current)?.projectRoot ?? "";
      return ctx.openProjectEditor();
    }
    select.disabled = true;
    ctx.$("#project-pill").classList.add("is-loading");
    void ctx
      .send(`/project ${value}`)
      .then(ok => {
        if (!ok) ctx.renderState();
      })
      .finally(() => {
        select.disabled = false;
        ctx.$("#project-pill").classList.remove("is-loading");
      });
  });
  ctx.$("#open-project").addEventListener(
    "click",
    () =>
      void ctx.withPending(ctx.$("#open-project"), async () => {
        const tauri = (window as Window & { __TAURI__?: { dialog?: { open(options: { directory: boolean; multiple: boolean }): Promise<string | null> } } })
          .__TAURI__;
        const dialog = tauri?.dialog;
        const path = await chooseProjectPath(dialog ? () => dialog.open({ directory: true, multiple: false }) : undefined, () =>
          window.prompt(ctx.t("web.top.projectPrompt")),
        );
        if (path) await ctx.send(`/project ${path}`);
        return undefined;
      }),
  );

  // ---- 詳細表示 ----
  const detailButton = ctx.$("#detail");
  const setDetail = (value: boolean) => {
    ctx.store.detail = value;
    ctx.storage.set(ctx.DETAIL_KEY, value ? "1" : "0");
    ctx.store.opened.clear();
    detailButton.setAttribute("aria-pressed", String(value));
    ctx.renderLog(true);
  };
  detailButton.setAttribute("aria-pressed", String(ctx.store.detail));
  detailButton.addEventListener("click", () => setDetail(!ctx.store.detail));
  return {};
}
