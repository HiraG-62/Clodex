import { afterEach, describe, expect, it, vi } from "vitest";
import type { createCommandExecutor } from "../cli/command-runner.js";
import { runSpecCheck, SPEC_CHECK_TIMEOUT_MS } from "./spec-check.js";

afterEach(() => vi.useRealTimers());
describe("specCheck", () => {
  it.each([0, 3])("終了コード %i と出力の末尾を記録する", async exitCode => {
    const execute: ReturnType<typeof createCommandExecutor> = (command, cwd, print, complete) => {
      expect(command).toBe("check 'docs/a b''c.md'");
      expect(cwd).toBe("root");
      for (let i = 0; i < 30; i++) print(String(i));
      complete({ code: exitCode, stopped: false });
      return { running: false, stop: () => false };
    };
    expect(await runSpecCheck("check {spec}", "docs/a b'c.md", "root", execute)).toEqual({
      command: "check 'docs/a b''c.md'",
      exitCode,
      output: Array.from({ length: 20 }, (_, i) => String(i + 10)).join("\n"),
    });
  });
  it("60 秒で子プロセスを止めて診断を返す", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(() => true);
    const execute: ReturnType<typeof createCommandExecutor> = (_command, _cwd, print) => {
      print("x".repeat(3000));
      return { running: true, stop };
    };
    const pending = runSpecCheck("check {spec}", "spec.md", "root", execute);
    await vi.advanceTimersByTimeAsync(SPEC_CHECK_TIMEOUT_MS);
    const result = await pending;
    expect(stop).toHaveBeenCalledOnce();
    expect(result.timedOut).toBe(true);
    expect(result.output).toHaveLength(2000);
  });
});
