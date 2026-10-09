import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuiPush, guiUpdateButton, shouldReportProgress } from "./gui-push.js";
import type { ClientContext } from "./store.js";

class ElementStub {
  children: ElementStub[] = [];
  hidden = false;
  type = "";
  classList = { add: vi.fn() };
  listeners = new Map<string, () => void>();
  constructor(readonly className = "") {}
  append(...nodes: ElementStub[]) {
    this.children.push(...nodes);
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
  click() {
    this.listeners.get("click")?.();
  }
}

const makeContext = () => {
  const nodes: ElementStub[] = [];
  const storage = { get: vi.fn(() => null), set: vi.fn(), remove: vi.fn(), keys: vi.fn(() => []) };
  const ctx = {
    store: { settingsRequests: new Set<string>(), pushId: undefined, gui: null },
    storage,
    t: (key: string) => key,
    el: (_tag: string, className = "") => {
      const node = new ElementStub(className);
      nodes.push(node);
      return node;
    },
    settingsSwitch: () => new ElementStub(),
    withPending: (_button: ElementStub, operation: () => Promise<Response>) => operation(),
    setPending: vi.fn(),
    refreshOpenSheet: vi.fn(),
    showToast: vi.fn(),
  } as unknown as ClientContext;
  return { ctx, nodes, storage };
};

afterEach(() => vi.unstubAllGlobals());

describe("createGuiPush", () => {
  it("更新の状態に応じて一つのボタンの文言と動きを決める", () => {
    expect(guiUpdateButton(undefined)).toEqual({ key: "web.settings.checkUpdate", action: "check", disabled: false });
    expect(guiUpdateButton({ status: "latest" })).toEqual({ key: "web.settings.checkUpdate", action: "check", disabled: false });
    expect(guiUpdateButton({ status: "error", message: "失敗" })).toEqual({ key: "web.settings.checkUpdate", action: "check", disabled: false });
    expect(guiUpdateButton({ status: "checking" })).toEqual({ key: "web.settings.updateChecking", disabled: true });
    expect(guiUpdateButton({ status: "available", version: "2.0" })).toEqual({
      key: "web.settings.updateVersion",
      params: { version: "2.0" },
      action: "install",
      disabled: false,
    });
    expect(guiUpdateButton({ status: "installing" })).toEqual({ key: "web.settings.updateInstalling", disabled: true });
    expect(guiUpdateButton({ status: "installing", progress: 45 })).toEqual({
      key: "web.settings.updateInstallingProgress",
      params: { progress: 45 },
      disabled: true,
    });
  });

  it("進捗は 5% 以上進んだときと 100% で送る", () => {
    expect([0, 4, 5, 9, 10, 99, 100].filter(progress => shouldReportProgress(0, progress))).toEqual([5, 9, 10, 99, 100]);
    expect(shouldReportProgress(5, 9)).toBe(false);
    expect(shouldReportProgress(5, 10)).toBe(true);
    expect(shouldReportProgress(98, 100)).toBe(true);
    expect(shouldReportProgress(100, 100)).toBe(false);
  });
  it("Push 対応の画面だけ通知設定を出し、購読端末の表示状態を送る", () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: (name: string, listener: () => void) => listeners.set(name, listener) });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("window", { PushManager: class {} });
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const { ctx } = makeContext();
    const { pushSection } = createGuiPush(ctx);
    expect(pushSection().hidden).toBe(false);
    ctx.store.pushId = "device-1";
    listeners.get("visibilitychange")?.();
    expect(fetch).toHaveBeenCalledWith("/api/push/visibility", expect.objectContaining({ body: JSON.stringify({ id: "device-1", visible: true }) }));
  });

  it("Tauri の画面では通知設定を隠す", () => {
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("window", { PushManager: class {}, __TAURI__: {} });
    const { pushSection } = createGuiPush(makeContext().ctx);
    expect(pushSection().hidden).toBe(true);
  });

  it("購読時に Hub の鍵を使う", async () => {
    const subscribe = vi.fn().mockResolvedValue({ toJSON: () => ({ endpoint: "test" }) });
    const registration = { pushManager: { subscribe } };
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    vi.stubGlobal("navigator", { serviceWorker: { register: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration) } });
    vi.stubGlobal("window", { PushManager: class {} });
    vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(url === "/api/push/key" ? { json: async () => ({ key: "AQID" }) } : { ok: true, json: async () => ({ id: "device-1" }) }),
      ),
    );
    const { ctx, storage } = makeContext();
    let pick: ((checked: boolean, button: HTMLButtonElement) => void) | undefined;
    ctx.settingsSwitch = (_key, _label, _checked, action) => {
      pick = action;
      return new ElementStub() as unknown as HTMLElement;
    };
    createGuiPush(ctx).pushSection();
    pick?.(true, new ElementStub() as unknown as HTMLButtonElement);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalledWith("clodex-push-id", "device-1"));
  });

  it("GUI 更新を Tauri の command と Hub の更新依頼へ送る", async () => {
    const invoke = vi.fn((command: string) => Promise.resolve(command === "check_update" ? "2.0" : undefined));
    class Channel {
      onmessage = (_progress: number) => {};
    }
    vi.stubGlobal("window", { __TAURI__: { core: { invoke, Channel } }, confirm: () => true });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const { ctx, nodes } = makeContext();
    const { runGuiCommand, guiUpdateSection } = createGuiPush(ctx);
    await runGuiCommand("install");
    await runGuiCommand("check");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["install_update", "check_update"]);
    const progressChannel = (invoke.mock.calls[0] as unknown as [string, { onProgress: Channel }])[1].onProgress;
    for (const progress of [4, 5, 9, 10, 100]) progressChannel.onmessage(progress);
    const installing = fetch.mock.calls
      .filter(([path]) => path === "/api/gui/status")
      .map(([, options]) => JSON.parse(options.body as string) as { status: string; progress?: number })
      .filter(value => value.status === "installing");
    expect(installing).toEqual([
      { status: "installing", progress: 5 },
      { status: "installing", progress: 10 },
      { status: "installing", progress: 100 },
    ]);
    expect(fetch).toHaveBeenCalledWith("/api/gui/status", expect.objectContaining({ body: JSON.stringify({ status: "available", version: "2.0" }) }));
    guiUpdateSection();
    nodes.find(node => node.className === "btn gui-update-action")?.click();
    expect(fetch).toHaveBeenCalledWith("/api/gui/update", expect.objectContaining({ body: JSON.stringify({ action: "check" }) }));
    ctx.store.gui = { version: "1.0", update: { status: "available", version: "2.0" } } as NonNullable<typeof ctx.store.gui>;
    nodes.find(node => node.className === "btn gui-update-action")?.click();
    expect(fetch).toHaveBeenCalledWith("/api/gui/update", expect.objectContaining({ body: JSON.stringify({ action: "install" }) }));
  });
});
