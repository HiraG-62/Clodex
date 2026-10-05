import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveProjectRole } from "./role-settings.js";

describe("saveProjectRole", () => {
  it("既存のキーともう一方の役割を残して、改行を空白にして保存する", () => {
    const root = mkdtempSync(join(tmpdir(), "clodex-role-"));
    writeFileSync(join(root, ".clodex.json"), JSON.stringify({ language: "ja", roles: { codex: "review" } }));
    expect(saveProjectRole(root, "claude", " design\n and\r\nreview ")).toBe("design and review");
    expect(JSON.parse(readFileSync(join(root, ".clodex.json"), "utf8"))).toEqual({
      language: "ja", roles: { codex: "review", claude: "design and review" },
    });
  });

  it("設定ファイルが無い project にも役割を作る", () => {
    const root = mkdtempSync(join(tmpdir(), "clodex-role-"));
    saveProjectRole(root, "codex", "実装");
    expect(JSON.parse(readFileSync(join(root, ".clodex.json"), "utf8"))).toEqual({ roles: { codex: "実装" } });
  });

  it("空の役割は保存しない", () => {
    const root = mkdtempSync(join(tmpdir(), "clodex-role-"));
    expect(() => saveProjectRole(root, "claude", " \n ")).toThrow("role must not be empty");
  });
});
