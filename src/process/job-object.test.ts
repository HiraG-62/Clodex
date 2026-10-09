import { describe, expect, it, vi } from "vitest";
import { registerHubJob } from "./job-object.js";

describe("registerHubJob", () => {
  it("Windows 以外では helper を起動しない", async () => {
    const run = vi.fn();
    expect(await registerHubJob({ platform: "linux", run })).toEqual({ ok: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("helper の成功を返す", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: "" });
    expect(await registerHubJob({ platform: "win32", pid: 123, run })).toEqual({ ok: true });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toContain("123");
  });

  it("helper の失敗を例外にしない", async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stderr: "AssignProcessToJobObject\r\nfailed" });
    expect(await registerHubJob({ platform: "win32", run })).toEqual({ ok: false, message: "AssignProcessToJobObject failed" });
  });

  it("起動できない場合も例外にしない", async () => {
    const run = vi.fn().mockRejectedValue(new Error("PowerShell missing"));
    expect(await registerHubJob({ platform: "win32", run })).toEqual({ ok: false, message: "PowerShell missing" });
  });

  it("時間切れで helper を中断する", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn((_script: string, signal: AbortSignal) => new Promise<{ code: number; stderr: string }>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const result = registerHubJob({ platform: "win32", run, timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(await result).toEqual({ ok: false, message: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
