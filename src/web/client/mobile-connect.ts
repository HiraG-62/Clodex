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
  const openMobileConnect = async () => {
    ctx.store.sheetKind = "mobileConnect";
    const body = ctx.el("div", "mobile-connect-body");
    const loading = ctx.el("div", "setting-pending");
    loading.append(ctx.el("span", "spin"), ctx.el("span", "", ctx.t("web.viewer.loading")));
    body.append(loading);
    ctx.openSheet(ctx.t("web.mobileConnect.title"), [body]);
    try {
      const response = await fetch("/api/connect", { cache: "no-store" });
      const result = (await response.json()) as ConnectResult;
      if (ctx.store.sheetKind !== "mobileConnect") return;
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
    } catch {
      if (ctx.store.sheetKind === "mobileConnect") body.replaceChildren(ctx.el("p", "mobile-connect-status", ctx.t("web.mobileConnect.failed")));
    }
  };
  const mobileConnectSection = () => {
    const section = ctx.el("div", "setting mobile-connect-setting");
    const label = ctx.t("web.mobileConnect.title");
    const button = ctx.iconButton("qr", label);
    button.addEventListener("click", () => {
      void openMobileConnect();
    });
    section.append(ctx.el("div", "eyebrow", label), button);
    return section;
  };
  return { mobileConnectSection, openMobileConnect };
}
