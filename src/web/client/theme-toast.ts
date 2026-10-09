import type { SendKey } from "./send-key.js";
import type { ClientContext } from "./store.js";

export function createThemeToast(ctx: ClientContext) {
  type Theme = (typeof ctx.THEMES)[number];

  // ---- テーマ ----
  const applyTheme = (theme: Theme) => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  };
  ctx.store.theme = (ctx.THEMES as readonly string[]).includes(ctx.storage.get(ctx.THEME_KEY) ?? "") ? (ctx.storage.get(ctx.THEME_KEY) as Theme) : "system";
  ctx.store.sendKey = (ctx.SEND_KEYS as readonly string[]).includes(ctx.storage.get(ctx.SEND_KEY_KEY) ?? "")
    ? (ctx.storage.get(ctx.SEND_KEY_KEY) as SendKey)
    : "enter";
  applyTheme(ctx.store.theme);
  const THEME_ICON: Record<Theme, string> = { system: "monitor", light: "sun", dark: "moon" };
  const syncThemeButton = (button: HTMLButtonElement, text: boolean) => {
    const label = ctx.t("web.settings.themeCurrent", { theme: ctx.t(ctx.THEME_LABEL[ctx.store.theme]) });
    button.title = label;
    button.setAttribute("aria-label", label);
    button.replaceChildren(ctx.icon(THEME_ICON[ctx.store.theme]));
    if (text) button.append(ctx.el("span", "", label));
  };
  const cycleTheme = () => {
    ctx.store.theme = ctx.THEMES[(ctx.THEMES.indexOf(ctx.store.theme) + 1) % ctx.THEMES.length]!;
    ctx.storage.set(ctx.THEME_KEY, ctx.store.theme);
    applyTheme(ctx.store.theme);
    syncThemeButton(ctx.$("#cycle-theme"), false);
    const menuButton = document.querySelector<HTMLButtonElement>("#mobile-theme");
    if (menuButton) syncThemeButton(menuButton, true);
  };
  syncThemeButton(ctx.$("#cycle-theme"), false);
  ctx.$("#cycle-theme").addEventListener("click", cycleTheme);

  // ---- トースト ----
  // heading: 通知のタイトル。本文の上の行に出す
  const showToast = (text: string, level: "info" | "warn" = "info", heading?: string) => {
    const container = ctx.$("#toast");
    const toast = ctx.el("button", `toast-item ${level}`);
    const content = ctx.el("span", "toast-text");
    if (heading) content.append(ctx.el("b", "toast-title", heading));
    content.append(ctx.el("span", "", text));
    toast.append(ctx.icon(level === "warn" ? "alert" : "check-circle"), content, ctx.icon("x"));
    toast.setAttribute("aria-label", `${heading ? `${heading} ` : ""}${text} · ${ctx.t("web.sheet.close")}`);
    toast.title = ctx.t("web.sheet.close");
    const dismiss = () => {
      toast.classList.add("leaving");
      window.setTimeout(() => toast.remove(), ctx.TOAST_EXIT_MS);
    };
    container.append(toast);
    const timer = window.setTimeout(dismiss, ctx.TOAST_DURATION_MS);
    toast.addEventListener("click", () => {
      window.clearTimeout(timer);
      dismiss();
    });
    while (container.children.length > ctx.MAX_TOASTS) container.firstElementChild?.remove();
  };
  return { showToast, THEME_ICON, syncThemeButton, cycleTheme };
}
