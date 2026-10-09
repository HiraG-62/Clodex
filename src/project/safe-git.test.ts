import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { safeGitArgs } from "./safe-git.js";

it("全コマンドで hooks と fsmonitor を無効化し、diff では外部処理も止める", () => {
  expect(safeGitArgs(["diff", "HEAD", "--", "a.txt"])).toEqual([
    "-c",
    "core.fsmonitor=false",
    "-c",
    expect.stringContaining("core.hooksPath="),
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD",
    "--",
    "a.txt",
  ]);
  expect(safeGitArgs(["ls-files"])).toEqual(["-c", "core.fsmonitor=false", "-c", expect.stringContaining("core.hooksPath="), "ls-files"]);
});

it("repo の fsmonitor・hook・外部 diff を実行しない", () => {
  const root = mkdtempSync(join(tmpdir(), "clodex-safe-git-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "a.txt"), "before");
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);
  const marker = join(root, "executed").replaceAll("\\", "/");
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\necho invoked > '${marker}'\n`, { mode: 0o755 });
  git(["config", "core.hooksPath", hooks]);
  git(["config", "core.fsmonitor", `echo invoked > '${marker}'`]);
  git(["config", "diff.external", `echo invoked > '${marker}'`]);
  writeFileSync(join(root, "a.txt"), "after");
  git(safeGitArgs(["diff", "HEAD"]));
  git(safeGitArgs(["commit", "--allow-empty", "-qm", "safe"]));
  expect(existsSync(join(root, "executed"))).toBe(false);
});
