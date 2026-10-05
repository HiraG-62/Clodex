// serve の所在。GUI は生きている Hub だけを再利用する（DESIGN.md §28 D3）
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../project/atomic-write.js";

export interface HubLock {
  pid: number;
  port: number;
  url: string;
}

export const hubLockPath = (homeDir: string): string => join(homeDir, ".clodex", "hub.lock");

export const readHubLock = (homeDir: string): HubLock | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(hubLockPath(homeDir), "utf8"));
    if (!value || typeof value !== "object") return undefined;
    const lock = value as Record<string, unknown>;
    if (!Number.isSafeInteger(lock.pid) || !Number.isSafeInteger(lock.port) || typeof lock.url !== "string") return undefined;
    const pid = lock.pid as number;
    const port = lock.port as number;
    if (pid <= 0 || port <= 0) return undefined;
    if (lock.url !== `http://127.0.0.1:${port}`) return undefined;
    return { pid, port, url: lock.url };
  } catch {
    return undefined;
  }
};

export const isHubAlive = (lock: HubLock): boolean => {
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const writeHubLock = (homeDir: string, lock: HubLock): void => {
  writeFileAtomic(hubLockPath(homeDir), `${JSON.stringify(lock)}\n`);
};

export const clearHubLock = (homeDir: string, pid: number): void => {
  if (readHubLock(homeDir)?.pid !== pid) return;
  try { unlinkSync(hubLockPath(homeDir)); } catch { /* 既に消えた場合 */ }
};
