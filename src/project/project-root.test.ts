import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectRoot } from "./project-root.js";

// Windows の runner の一時フォルダは 8.3 形式（RUNNER~1）。git が返す長い形式にそろえるため native で解決する
const makeTempDir = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), "clodex-root-")));

describe("resolveProjectRoot", () => {
  it("--project が指定されていればそれを最優先する", () => {
    const explicit = makeTempDir();
    expect(resolveProjectRoot({ explicitProject: explicit, cwd: process.cwd() })).toBe(explicit);
  });

  it("git リポジトリ内なら toplevel を返す", () => {
    const repo = makeTempDir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectRoot({ cwd: nested })).toBe(repo);
  });

  it("git 外なら cwd を返す", () => {
    const dir = makeTempDir();
    expect(resolveProjectRoot({ cwd: dir })).toBe(dir);
  });
});
