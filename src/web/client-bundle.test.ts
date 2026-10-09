import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadClientAssets } from "./client-bundle.js";

const sourceDir = join(import.meta.dirname, "client");

describe("loadClientAssets", () => {
  it("成果物があればそのまま使う", () => {
    const dir = mkdtempSync(join(tmpdir(), "clodex-client-assets-"));
    writeFileSync(join(dir, "client.js"), "built script");
    writeFileSync(join(dir, "style.css"), "built style");
    expect(loadClientAssets(dir, sourceDir)).toEqual({ script: "built script", style: "built style" });
  });

  it("成果物がなければ source を bundle する", () => {
    const dir = mkdtempSync(join(tmpdir(), "clodex-client-assets-"));
    const assets = loadClientAssets(dir, sourceDir);
    expect(assets.script).toContain("clodex-config");
    expect(assets.style).toContain(".app { display: grid;");
  });
});
