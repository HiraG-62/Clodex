import type { ClientContext } from "./store.js";

type ConnectResult =
  | { state: "ready"; url: string; qrSvg: string }
  | { state: "noServe"; command: string }
  | { state: "stopped" | "missing" }
  | { error: string };

export function createMobileConnect(ctx: ClientContext) {
  const copyButton = (value: string) => {
    const button = ctx.iconButton("copy", ctx.t("web.code.copy"), "mobile-connect-copy");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(value);
        ctx.showToast(ctx.t("web.code.copied"));
      } catch {
        ctx.showToast(ctx.t("web.code.copyFailed"));
      }
    });
    return button;
  };
  const copyable = (value: string) => {
    const row = ctx.el("div", "mobile-connect-value");
    row.append(ctx.el("code", "", value), copyButton(value));
    return row;
  };
  const showResult = (body: HTMLElement, result: ConnectResult) => {
    if ("error" in result) {
      body.replaceChildren(ctx.el("p", "mobile-connect-status", result.error));
      return;
    }
    if (result.state === "ready") {
      const qr = ctx.el("div", "mobile-connect-qr");
      qr.innerHTML = result.qrSvg;
      body.replaceChildren(qr, copyable(result.url));
      return;
    }
    const key =
      result.state === "noServe" ? "web.mobileConnect.noServe" : result.state === "stopped" ? "web.mobileConnect.stopped" : "web.mobileConnect.missing";
    body.replaceChildren(ctx.el("p", "mobile-connect-status", ctx.t(key)));
    if (result.state === "noServe") body.append(copyable(result.command));
  };
  const showSheet = (result?: ConnectResult) => {
    ctx.store.sheetKind = "mobileConnect";
    const body = ctx.el("div", "mobile-connect-body");
    if (result) showResult(body, result);
    else {
      const loading = ctx.el("div", "setting-pending");
      loading.append(ctx.el("span", "spin"), ctx.el("span", "", ctx.t("web.viewer.loading")));
      body.append(loading);
    }
    ctx.openSheet(ctx.t("web.mobileConnect.title"), [body]);
    return body;
  };
  const openMobileConnect = async () => {
    const body = showSheet();
    try {
      const response = await fetch("/api/connect", { cache: "no-store" });
      const result = (await response.json()) as ConnectResult;
      if (ctx.store.sheetKind !== "mobileConnect") return;
      showResult(body, result);
    } catch {
      if (ctx.store.sheetKind === "mobileConnect") body.replaceChildren(ctx.el("p", "mobile-connect-status", ctx.t("web.mobileConnect.failed")));
    }
  };
  const reissue = async (button: HTMLButtonElement) => {
    button.disabled = true;
    ctx.store.tokenRotating = true;
    try {
      const response = await fetch("/api/connect/rotate", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      showSheet((await response.json()) as ConnectResult);
    } catch {
      ctx.showToast(ctx.t("web.mobileConnect.failed"), "warn");
    } finally {
      ctx.store.tokenRotating = false;
      button.disabled = false;
    }
  };
  const confirmReissue = () => {
    ctx.store.sheetKind = "tokenConfirm";
    const body = ctx.el("div", "mobile-connect-confirm");
    const actions = ctx.el("div", "mobile-connect-confirm-actions");
    const back = ctx.el("button", "btn", ctx.t("web.viewer.back")) as HTMLButtonElement;
    const accept = ctx.el("button", "btn primary", ctx.t("web.mobileConnect.reissue")) as HTMLButtonElement;
    back.type = "button";
    accept.type = "button";
    back.addEventListener("click", () => ctx.openSettings());
    accept.addEventListener("click", () => void reissue(accept));
    actions.append(back, accept);
    body.append(ctx.el("p", "", ctx.t("web.mobileConnect.reissueConfirm")), actions);
    ctx.openSheet(ctx.t("web.mobileConnect.reissue"), [body]);
  };
  const mobileConnectSection = () => {
    const section = ctx.el("div", "setting mobile-connect-setting");
    const label = ctx.t("web.mobileConnect.title");
    const button = ctx.iconButton("qr", label);
    button.addEventListener("click", () => {
      void openMobileConnect();
    });
    const reissueButton = ctx.el("button", "mobile-connect-reissue", ctx.t("web.mobileConnect.reissue")) as HTMLButtonElement;
    reissueButton.type = "button";
    reissueButton.addEventListener("click", confirmReissue);
    const actions = ctx.el("div", "mobile-connect-actions");
    actions.append(button, reissueButton);
    section.append(ctx.el("div", "eyebrow", label), actions);
    return section;
  };
  return { mobileConnectSection, openMobileConnect };
}
