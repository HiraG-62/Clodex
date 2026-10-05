import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listProjectFiles } from "./project-files.js";

const makeProject = () => {
  const root = mkdtempSync(join(tmpdir(), "clodex-files-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "README.md"), "");
  return root;
};

describe("listProjectFiles", () => {
  it("git の管理下と未追跡の新規ファイルを返し、.gitignore は除く", async () => {
    const root = makeProject();
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "ignored.log\n");
    writeFileSync(join(root, "ignored.log"), "");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    expect((await listProjectFiles(root)).sort()).toEqual([".gitignore", "README.md", "src/a.ts"]);
  });

  it("git の repository でなければ空", async () => {
    expect(await listProjectFiles(makeProject())).toEqual([]);
  });
});
