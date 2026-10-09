import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { installRuntimeErrors } from "./runtime-errors.js";

it.each([false, true])("実プロセスで rejection は継続し、致命的例外は stderr を残して終了する: %s", fatal => {
  const home = mkdtempSync(join(tmpdir(), "clodex-errors-process-"));
  const script = `import {installRuntimeErrors} from ${JSON.stringify(new URL("./runtime-errors.ts", import.meta.url).href)};
    installRuntimeErrors({home:process.argv[1],report:message=>console.log('error',message)});
    ${fatal ? "setTimeout(()=>{throw new Error('diagnostic')},0)" : "Promise.reject(new Error('diagnostic'))"};
    setTimeout(()=>console.log('alive'),30);`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, home], { encoding: "utf8", timeout: 10_000 });
  expect(result.status).toBe(fatal ? 1 : 0);
  expect(result.stderr).toContain("Error: diagnostic");
  expect(result.stdout).toContain("error diagnostic");
  expect(result.stdout.includes("alive")).toBe(!fatal);
});

it("rejection と I/O 例外は記録・表示し、未知の例外は異常終了を保存する", () => {
  const home = mkdtempSync(join(tmpdir(), "clodex-errors-"));
  const events = new EventEmitter(),
    report = vi.fn(),
    exit = vi.fn(),
    stderr = vi.fn();
  const errors = installRuntimeErrors({ home, events, report, exit, stderr });
  events.emit("unhandledRejection", new Error("rejected"));
  for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]) events.emit("uncaughtException", Object.assign(new Error(code), { code }));
  expect(report).toHaveBeenCalledTimes(4);
  expect(exit).not.toHaveBeenCalled();
  expect(existsSync(join(home, ".clodex", "hub-failure.json"))).toBe(false);
  events.emit("uncaughtException", new Error("fatal"));
  expect(exit).toHaveBeenCalledWith(1);
  expect(JSON.parse(readFileSync(join(home, ".clodex", "hub-failure.json"), "utf8"))).toMatchObject({ message: "fatal" });
  expect(readFileSync(errors.logPath, "utf8")).toContain("Error: rejected");
  expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("Error: fatal"));
  errors.dispose();
  expect(events.listenerCount("uncaughtException")).toBe(0);
});

it("表示と stderr の失敗が重なっても致命的な例外の記録と終了を続ける", () => {
  const home = mkdtempSync(join(tmpdir(), "clodex-errors-"));
  const exit = vi.fn();
  const errors = installRuntimeErrors({
    home,
    events: new EventEmitter(),
    exit,
    report: () => {
      throw new Error("UI unavailable");
    },
    stderr: () => {
      throw new Error("closed");
    },
  });
  errors.fatal(new Error("fatal"));
  expect(exit).toHaveBeenCalledWith(1);
  expect(readFileSync(errors.logPath, "utf8")).toContain("fatal");
  errors.dispose();
});
