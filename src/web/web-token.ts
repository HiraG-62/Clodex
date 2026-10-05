// Web UI の token。スマホで毎回入れ直さなくて済むよう、起動をまたいで同じ値を使う（DESIGN.md §17 Web UI）
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const webTokenPath = (homeDir: string): string => join(homeDir, ".clodex", "web-token");

export const loadOrCreateWebToken = (homeDir: string): string => {
  const path = webTokenPath(homeDir);
  if (existsSync(path)) {
    const saved = readFileSync(path, "utf8").trim();
    if (TOKEN_PATTERN.test(saved)) return saved;
  }
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
};
