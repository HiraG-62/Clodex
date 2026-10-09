import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gitProtectionPaths } from "./git-protection.js";

it("通常の .git と worktree の共通 metadata を保護対象にする", async () => {
  const root = await mkdtemp(join(tmpdir(), "clodex-git-protection-"));
  const main = join(root, "main"),
    work = join(root, "work");
  const common = join(main, ".git"),
    metadata = join(common, "worktrees", "work");
  await mkdir(metadata, { recursive: true });
  await mkdir(work);
  await writeFile(join(work, ".git"), `gitdir: ${metadata}\n`);
  await writeFile(join(metadata, "commondir"), "../..\n");
  expect(await gitProtectionPaths(main)).toEqual([{ path: common, kind: "git-root" }]);
  expect(await gitProtectionPaths(work)).toEqual([
    { path: join(work, ".git"), kind: "git-file" },
    { path: metadata, kind: "git-root" },
    { path: common, kind: "git-root" },
  ]);
  expect(await gitProtectionPaths(root)).toEqual([]);
});

it("不正な .git ファイルを拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "clodex-git-protection-"));
  await writeFile(join(root, ".git"), "not a git pointer");
  await expect(gitProtectionPaths(root)).rejects.toThrow();
});
