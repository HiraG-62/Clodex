import { EventEmitter } from "node:events";
import { join, isAbsolute } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { brokerSource } from "./broker-source.js";

it.each(["pnpm.cjs", "pnpm.mjs"])("pnpm の %s を Node で起動する", (filename) => {
  const input = Object.assign(new EventEmitter(), { close: vi.fn() });
  const protocol = new EventEmitter();
  const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), write: vi.fn(), destroy: vi.fn(), destroyed: false });
  const child = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: { resume: vi.fn() } });
  const spawn = vi.fn(() => child);
  const script = join("profile", "npm", "node_modules", "pnpm", "bin", filename);
  const modules: Record<string, unknown> = {
    "node:child_process": { spawn }, "node:net": { connect: () => socket },
    "node:readline": { createInterface: vi.fn().mockReturnValueOnce(input).mockReturnValueOnce(protocol) },
    "node:crypto": { timingSafeEqual: (a: Buffer, b: Buffer) => a.equals(b) },
    "node:fs": { existsSync: (path: string) => path === script }, "node:path": { join, isAbsolute },
  };
  runInNewContext(brokerSource, {
    require: (name: string) => modules[name], __dirname: "runtime", Buffer,
    process: { argv: ["node", "broker", "123", "sid"], execPath: "node.exe", env: { APPDATA: "profile" }, stdin: { destroy: vi.fn() }, on: vi.fn() },
  });
  input.emit("line", "secret");
  protocol.emit("line", JSON.stringify({ type: "welcome", token: "secret" }));
  protocol.emit("line", JSON.stringify({ type: "start", id: 1, command: "pnpm", args: ["--version"], cwd: "project" }));
  expect(spawn).toHaveBeenCalledWith(join("runtime", "token-helper.exe"), ["sid", "project", "4294967295", "node.exe", script, "--version"], expect.any(Object));
});
