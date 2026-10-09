import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { clearHubLock, hubLockPath, isHubAlive, readHubLock, writeHubLock } from "./hub-lock.js";

describe("hub.lock", () => {
  it("pid・port・url を保存し、生存する Hub を読める", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "clodex-hub-lock-"));
    const lock = { pid: process.pid, port: 4319, url: "http://127.0.0.1:4319" };
    writeHubLock(homeDir, lock);
    expect(JSON.parse(readFileSync(hubLockPath(homeDir), "utf8"))).toEqual(lock);
    expect(readHubLock(homeDir)).toEqual(lock);
    expect(await isHubAlive(lock, vi.fn().mockResolvedValue({ status: 200 }))).toBe(true);
    clearHubLock(homeDir, process.pid);
    expect(existsSync(hubLockPath(homeDir))).toBe(false);
  });

  it.each([
    ["接続できない", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["200 以外", () => Promise.resolve({ status: 503 })],
    ["timeout", () => Promise.reject(new DOMException("timeout", "TimeoutError"))],
  ])("pid が生きていても HTTP が %s なら生存とみなさない", async (_reason, response) => {
    const lock = { pid: process.pid, port: 4319, url: "http://127.0.0.1:4319" };
    const request = vi.fn(response);
    expect(await isHubAlive(lock, request)).toBe(false);
    expect(request).toHaveBeenCalledWith(`${lock.url}/manifest.webmanifest`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("壊れた lock を無視し、別の pid の lock を消さない", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "clodex-hub-lock-"));
    mkdirSync(join(homeDir, ".clodex"));
    writeFileSync(hubLockPath(homeDir), "invalid");
    expect(readHubLock(homeDir)).toBeUndefined();
    writeHubLock(homeDir, { pid: process.pid, port: 4319, url: "http://127.0.0.1:4319" });
    clearHubLock(homeDir, process.pid + 1);
    expect(existsSync(hubLockPath(homeDir))).toBe(true);
  });
});
