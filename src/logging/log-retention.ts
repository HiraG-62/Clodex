// ~/.clodex/logs の古いログを消す（DESIGN.md §17 ログの保持）
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";

const LOG_DIR = join(".clodex", "logs");
const RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_EXTENSIONS: ReadonlySet<string> = new Set([".jsonl", ".log"]);

const listLogs = (directory: string): string[] => {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
};

export const pruneLogs = (homeDir: string, now: Date = new Date()): void => {
  const directory = join(homeDir, LOG_DIR);
  const cutoff = now.getTime() - RETENTION_DAYS * DAY_MS;
  for (const name of listLogs(directory)) {
    if (!LOG_EXTENSIONS.has(extname(name))) continue;
    const path = join(directory, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      unlinkSync(path);
    } catch {
      // 書き込み中などで消せないファイルは次の起動に回す。
    }
  }
};
