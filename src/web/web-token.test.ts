import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateWebToken, webTokenPath } from "./web-token.js";

describe("loadOrCreateWebToken", () => {
  it("無ければ 32 桁の token を作って保存し、次回は同じ token を返す", () => {
    const home = mkdtempSync(join(tmpdir(), "clodex-token-"));
    const token = loadOrCreateWebToken(home);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(webTokenPath(home), "utf8").trim()).toBe(token);
    expect(loadOrCreateWebToken(home)).toBe(token);
  });

  it("保存された内容が token の形式でなければ作り直す", () => {
    const home = mkdtempSync(join(tmpdir(), "clodex-token-"));
    loadOrCreateWebToken(home);
    writeFileSync(webTokenPath(home), "short");
    expect(loadOrCreateWebToken(home)).toMatch(/^[0-9a-f]{64}$/);
  });
});
