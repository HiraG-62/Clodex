import type { GuiAction, GuiUpdate } from "../web-feed.js";
import type { ClientContext } from "./store.js";

export function createGuiPush(ctx: ClientContext) {
  type TauriApi = { app?: { getVersion(): Promise<string> }; core?: { invoke<T>(command: string): Promise<T> } };

  // ---- GUI の更新（DESIGN.md §28 Web UI の設定からの更新）----

  const tauriApi = (window as Window & { __TAURI__?: TauriApi }).__TAURI__;

  ctx.store.gui = null;
  const postJson = (path: string, value: unknown) =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const runGuiCommand = async (action: GuiAction) => {
    const invoke = tauriApi?.core?.invoke;
    if (!invoke) return;
    try {
      if (action === "install") return void (await invoke<void>("install_update"));
      const version = await invoke<string | null>("check_update");
      await postJson("/api/gui/status", version ? { status: "available", version } : { status: "latest" });
    } catch (error) {
      await postJson("/api/gui/status", { status: "error", message: String(error) } satisfies GuiUpdate);
    }
  };
  const requestGuiUpdate = (action: GuiAction, button: HTMLButtonElement) => void ctx.withPending(button, () => postJson("/api/gui/update", { action }));
  const guiUpdateSection = () => {
    const section = ctx.el("section", "setting gui-update");
    const row = ctx.el("div", "gui-update-row");
    const check = ctx.el("button", "btn gui-check", ctx.t("web.settings.checkUpdate")) as HTMLButtonElement;
    check.type = "button";
    check.addEventListener("click", () => requestGuiUpdate("check", check));
    const install = ctx.el("button", "btn gui-install", ctx.t("web.settings.update")) as HTMLButtonElement;
    install.type = "button";
    install.addEventListener("click", () => {
      if (ctx.store.gui?.update?.status !== "available" || !window.confirm(ctx.t("web.settings.updateConfirm", { version: ctx.store.gui.update.version })))
        return;
      requestGuiUpdate("install", install);
    });
    row.append(ctx.el("span", "muted small gui-version"), check, ctx.el("span", "small gui-status"), install);
    section.append(row);
    return section;
  };
  // ---- スマホへの通知（DESIGN.md §28 スマホへの通知（Web Push））----
  const PUSH_ID_KEY = "clodex-push-id";
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && !tauriApi;
  ctx.pushSupported = pushSupported;
  ctx.store.pushId = ctx.storage.get(PUSH_ID_KEY) || undefined;
  const base64Bytes = (value: string) => {
    const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
  };
  const enablePush = async () => {
    if ((await Notification.requestPermission()) !== "granted") return ctx.showToast(ctx.t("web.push.denied"), "warn");
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const { key } = (await (await fetch("/api/push/key")).json()) as { key: string };
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Bytes(key) });
    const response = await postJson("/api/push/subscribe", subscription.toJSON());
    if (!response.ok) return;
    ctx.store.pushId = ((await response.json()) as { id: string }).id;
    ctx.storage.set(PUSH_ID_KEY, ctx.store.pushId);
  };
  const disablePush = async () => {
    const id = ctx.store.pushId;
    if (!id) return;
    ctx.store.pushId = undefined;
    ctx.storage.set(PUSH_ID_KEY, "");
    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
    await postJson("/api/push/unsubscribe", { id });
  };
  const pushSection = () => {
    const section = ctx.settingsSwitch("push", ctx.t("web.settings.push"), Boolean(ctx.store.pushId), (checked, button) => {
      ctx.store.settingsRequests.add("push");
      ctx.setPending(button, true);
      void (checked ? enablePush() : disablePush())
        .catch((error: unknown) => ctx.showToast(String(error), "warn"))
        .finally(() => {
          ctx.store.settingsRequests.delete("push");
          ctx.setPending(button, false);
          ctx.refreshOpenSheet();
        });
    });
    section.classList.add("push-settings");
    section.hidden = !pushSupported;
    return section;
  };
  const refreshPush = (body: HTMLElement) => {
    const button = body.querySelector<HTMLButtonElement>('[data-choice="push"][role="switch"]');
    if (!button) return;
    button.setAttribute("aria-checked", String(Boolean(ctx.store.pushId)));
    button.disabled = ctx.store.settingsRequests.has("push");
  };
  document.addEventListener("visibilitychange", () => {
    if (ctx.store.pushId) void postJson("/api/push/visibility", { id: ctx.store.pushId, visible: document.visibilityState === "visible" });
  });
  const guiStatusText = (update: GuiUpdate | undefined): string => {
    if (!update) return "";
    if (update.status === "available") return ctx.t("web.settings.updateAvailable", { version: update.version });
    if (update.status === "error") return ctx.t("web.settings.updateFailed", { message: update.message });
    return ctx.t(
      update.status === "checking" ? "web.settings.updateChecking" : update.status === "latest" ? "web.settings.updateLatest" : "web.settings.updateInstalling",
    );
  };
  const refreshGuiUpdate = (body: HTMLElement) => {
    let section = body.querySelector<HTMLElement>(".gui-update");
    if (!section && ctx.store.gui) {
      section = guiUpdateSection();
      body.querySelector(".settings-clodex .settings-card")?.append(section);
    }
    if (!section) return;
    section.hidden = !ctx.store.gui;
    if (!ctx.store.gui) return;
    const busy = ctx.store.gui.update?.status === "checking" || ctx.store.gui.update?.status === "installing";
    section.querySelector<HTMLElement>(".gui-version")!.textContent = ctx.t("web.settings.version", { version: ctx.store.gui.version });
    section.querySelector<HTMLButtonElement>(".gui-check")!.disabled = busy;
    section.querySelector<HTMLElement>(".gui-status")!.textContent = guiStatusText(ctx.store.gui.update);
    section.querySelector<HTMLButtonElement>(".gui-install")!.hidden = ctx.store.gui.update?.status !== "available";
  };
  return { pushSection, guiUpdateSection, refreshGuiUpdate, refreshPush, runGuiCommand, tauriApi };
}
