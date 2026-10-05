import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearHubLock, hubLockPath, isHubAlive, readHubLock, writeHubLock } from "./hub-lock.js";

describe("hub.lock", () => {
  it("pid・port・url を保存し、生存する Hub を読める", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "clodex-hub-lock-"));
    const lock = { pid: process.pid, port: 4319, url: "http://127.0.0.1:4319" };
    writeHubLock(homeDir, lock);
    expect(JSON.parse(readFileSync(hubLockPath(homeDir), "utf8"))).toEqual(lock);
    expect(readHubLock(homeDir)).toEqual(lock);
    expect(isHubAlive(lock)).toBe(true);
    clearHubLock(homeDir, process.pid);
    expect(existsSync(hubLockPath(homeDir))).toBe(false);
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
