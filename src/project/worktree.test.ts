import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree, worktreePlace } from "./worktree.js";

describe("worktreePlace", () => {
  it("project の隣に project 名と会話の短い ID で置き、clodex/ のブランチにする", () => {
    expect(worktreePlace(join("C:", "dev", "app"), "1a2b3c4d-5e6f-7a8b")).toEqual({
      workDir: join("C:", "dev", "app-1a2b3c4d"),
      branch: "clodex/1a2b3c4d",
    });
  });
});

describe("createWorktree", () => {
  it("git worktree を作り、作れなければ理由を返す", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "clodex-wt-")), "app");
    mkdirSync(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    writeFileSync(join(root, "a.txt"), "a");
    git("add", "a.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    writeFileSync(join(root, "a.txt"), "uncommitted");
    writeFileSync(join(root, "untracked.txt"), "local");

    const result = await createWorktree(root, "abcdef12-0000");
    expect(result).toMatchObject({ ok: true, worktree: { branch: "clodex/abcdef12" } });
    if (result.ok) {
      expect(existsSync(join(result.worktree.workDir, "a.txt"))).toBe(true);
      expect(readFileSync(join(result.worktree.workDir, "a.txt"), "utf8")).toBe("a");
      expect(existsSync(join(result.worktree.workDir, "untracked.txt"))).toBe(false);
    }
    // 同じブランチは作れない
    await expect(createWorktree(root, "abcdef12-0000")).resolves.toMatchObject({ ok: false });
  });
});
