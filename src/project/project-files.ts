// project root の中のファイルの判定と一覧（DESIGN.md §28 v0.3 A の @path）
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Web UI の候補に送る件数の上限（巨大な repository でも応答を重くしない）
export const MAX_PROJECT_FILES = 20_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// project root の外（.. や絶対パス）を指していないか
const insideRoot = (root: string, path: string): string | undefined => {
  if (isAbsolute(path)) return undefined;
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? absolute : undefined;
};

export const isProjectFile = (root: string, path: string): boolean => {
  const absolute = insideRoot(root, path);
  if (!absolute) return false;
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
};

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
