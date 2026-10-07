import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneLogs } from "./log-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 20, 12, 0, 0);

const setup = (files: Record<string, number>) => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-retention-"));
  const logs = join(homeDir, ".clodex", "logs");
  mkdirSync(logs, { recursive: true });
  for (const [name, ageDays] of Object.entries(files)) {
    const path = join(logs, name);
    writeFileSync(path, "x");
    const time = new Date(NOW.getTime() - ageDays * DAY_MS);
    utimesSync(path, time, time);
  }
  return { homeDir, logs };
};

describe("pruneLogs", () => {
  it("更新日時が 14 日より前の .jsonl と .log だけを消す", () => {
    const { homeDir, logs } = setup({
      "Clodex-old.jsonl": 15, "hub-old.log": 30, "hub-errors-old.log": 20,
      "Clodex-new.jsonl": 13, "hub-new.log": 1, "notes.txt": 100,
    });
    pruneLogs(homeDir, NOW);
    expect(readdirSync(logs).sort()).toEqual(["Clodex-new.jsonl", "hub-new.log", "notes.txt"]);
  });

  it("ディレクトリには触れず、logs が無くても例外を出さない", () => {
    const { homeDir, logs } = setup({});
    mkdirSync(join(logs, "old.log"));
    const time = new Date(NOW.getTime() - 100 * DAY_MS);
    utimesSync(join(logs, "old.log"), time, time);
    pruneLogs(homeDir, NOW);
    expect(readdirSync(logs)).toEqual(["old.log"]);
    expect(() => pruneLogs(join(homeDir, "missing"), NOW)).not.toThrow();
  });
});
