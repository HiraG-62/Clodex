// project のファイルの一覧（DESIGN.md §28 v0.3 A の @path の候補）
import { execFile } from "node:child_process";

// Web UI の候補に送る件数の上限（巨大な repository でも応答を重くしない）
export const MAX_PROJECT_FILES = 20_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// git の管理下のファイルと、未追跡の新規ファイル（.gitignore は除く）。git でなければ空
export const listProjectFiles = (root: string): Promise<string[]> =>
  new Promise((done) => {
    execFile(
      "git", ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error) return done([]);
        const files = [...new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
        done(files.slice(0, MAX_PROJECT_FILES));
      },
    );
  });
