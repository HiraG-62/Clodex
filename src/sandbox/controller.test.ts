import { expect, it, vi } from "vitest";
import { SandboxController, type SandboxPlatform } from "./controller.js";

function fixture() {
  const events: string[] = [];
  const platform: SandboxPlatform = {
    inspect: vi.fn(async () => true),
    connect: vi.fn(async () => { events.push("connect"); }),
    grant: vi.fn(async (path) => { events.push(`grant:${path}`); }),
    release: vi.fn(async () => { events.push("release"); }),
    close: vi.fn(async () => { events.push("close"); }),
    spawn: vi.fn(),
  };
  const controller = new SandboxController(platform, {
    paths: () => ({ projects: ["project", "worktree", "project"], artifacts: "artifacts" }),
    stop: async () => { events.push("stop"); },
    restart: async () => { events.push(`restart:${controller.enabled}`); },
    save: (enabled) => { events.push(`save:${enabled}`); },
  });
  return { platform, controller, events };
}

it("ready の検査結果を state 用に保持し、失敗時に古い値を残さない", async () => {
  const { controller, platform } = fixture();
  expect(controller.setupReady).toBe(false);
  expect(await controller.ready()).toBe(true);
  expect(controller.setupReady).toBe(true);
  vi.mocked(platform.inspect).mockRejectedValueOnce(new Error("検査失敗"));
  await expect(controller.ready()).rejects.toThrow("検査失敗");
  expect(controller.setupReady).toBe(false);
});

it("検査が通らなければ Agent・ACL・保存設定を変えない", async () => {
  const { platform, controller, events } = fixture();
  vi.mocked(platform.inspect).mockResolvedValue(false);
  await expect(controller.setEnabled(true)).rejects.toThrow();
  expect(events).toEqual([]);
  expect(controller.enabled).toBe(false);
});

it("project・worktree・artifacts を許可し、停止後に切り替える", async () => {
  const { controller, events } = fixture();
  await controller.setEnabled(true);
  expect(events).toEqual(["connect", "grant:project", "grant:worktree", "grant:artifacts", "stop", "save:true", "restart:true"]);
  await controller.setEnabled(true);
  expect(events.filter((event) => event === "connect")).toHaveLength(1);
  await controller.setEnabled(false);
  expect(events.slice(-5)).toEqual(["stop", "release", "close", "save:false", "restart:false"]);
});

it("ACL の途中失敗を解除し、設定を on にしない", async () => {
  const { platform, controller, events } = fixture();
  vi.mocked(platform.grant).mockRejectedValueOnce(new Error("ACL"));
  await expect(controller.setEnabled(true)).rejects.toThrow("ACL");
  expect(events).toEqual(["connect", "release", "close"]);
  expect(controller.enabled).toBe(false);
});

it("off の解除失敗では人の Agent を起動しない", async () => {
  const { platform, controller, events } = fixture();
  await controller.setEnabled(true);
  events.length = 0;
  vi.mocked(platform.release).mockRejectedValueOnce(new Error("解除失敗"));
  await expect(controller.setEnabled(false)).rejects.toThrow("解除失敗");
  expect(controller.enabled).toBe(true);
  expect(events).toEqual(["stop", "connect", "grant:project", "grant:worktree", "grant:artifacts", "restart:true"]);
});

it("保存済み on の検査失敗では起動を禁止し、off で復帰する", async () => {
  const { platform, controller, events } = fixture();
  vi.mocked(platform.inspect).mockResolvedValue(false);
  await controller.initialize();
  expect(controller.enabled).toBe(true);
  expect(controller.usable).toBe(false);
  expect(events).toEqual([]);
  await controller.setEnabled(false);
  expect(controller.usable).toBe(true);
  expect(events).toEqual(["stop", "release", "close", "save:false", "restart:false"]);
});

it("off の再実行でも残った lease を解除する", async () => {
  const { controller, events } = fixture();
  await controller.setEnabled(false);
  expect(events).toEqual(["release", "close"]);
});

it("prepare 後に停止が失敗したら ACL と broker を解除する", async () => {
  const { platform, events } = fixture();
  const controller = new SandboxController(platform, {
    paths: () => ({projects:["project"],artifacts:"artifacts"}),
    stop: async () => { throw new Error("停止失敗"); },
    restart: vi.fn(), save: vi.fn(),
  });
  await expect(controller.setEnabled(true)).rejects.toThrow("停止失敗");
  expect(events.slice(-2)).toEqual(["release","close"]);
  expect(controller.enabled).toBe(false);
});

it("初回 on の前にセットアップを完了し、失敗時には切り替えない", async () => {
  const { platform, controller, events } = fixture();
  platform.setup = vi.fn(async () => { events.push("setup"); throw new Error("UAC 拒否"); });
  await expect(controller.setEnabled(true)).rejects.toThrow("UAC 拒否");
  expect(events).toEqual(["setup"]);
  expect(controller.enabled).toBe(false);
});

it("on の再実行ではセットアップを繰り返して broker を閉じない", async () => {
  const {platform,controller}=fixture();
  platform.setup=vi.fn(async()=>{});
  await controller.setEnabled(true);await controller.setEnabled(true);
  expect(platform.setup).toHaveBeenCalledTimes(1);
  expect(platform.close).not.toHaveBeenCalled();
});

it("on のまま認証が失効したら再セットアップし、失敗時は起動を禁止する", async () => {
  const {platform,controller,events}=fixture();
  platform.setup=vi.fn(async()=>{});
  await controller.setEnabled(true);
  platform.ready=vi.fn(async()=>false);
  vi.mocked(platform.setup).mockRejectedValueOnce(new Error("未ログイン"));
  await expect(controller.setEnabled(true)).rejects.toThrow("未ログイン");
  expect(controller.enabled).toBe(true); expect(controller.usable).toBe(false);
  expect(events.at(-1)).toBe("stop");
  await controller.setEnabled(true);
  expect(controller.usable).toBe(true);
  expect(platform.setup).toHaveBeenCalledTimes(3);
});

it("保存済み on でも実認証が未完了なら Agent の起動を禁止する",async()=>{
  const {platform,controller}=fixture();platform.ready=vi.fn(async()=>false);
  await controller.initialize();
  expect(controller.enabled).toBe(true);expect(controller.usable).toBe(false);
  expect(platform.grant).not.toHaveBeenCalled();
});

it("uninstall は Agent 停止後に実行し、成功後だけ off を保存する", async () => {
  const { platform, controller, events } = fixture();
  platform.uninstall = vi.fn(async () => { events.push("uninstall"); });
  await controller.setEnabled(true);
  events.length = 0;
  await controller.uninstall();
  expect(events).toEqual(["stop", "uninstall", "save:false", "restart:false"]);
  expect(controller.enabled).toBe(false);
});
