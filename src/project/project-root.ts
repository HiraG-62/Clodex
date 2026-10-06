import { safeGitArgs } from "./safe-git.js";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export interface ProjectRootOptions {
  explicitProject?: string;
  cwd: string;
}

// 優先順位: --project > git toplevel > cwd（DESIGN.md §7）
export const resolveProjectRoot = ({ explicitProject, cwd }: ProjectRootOptions): string => {
  if (explicitProject) return resolve(explicitProject);
  return findGitToplevel(cwd) ?? resolve(cwd);
};

const findGitToplevel = (cwd: string): string | undefined => {
  try {
    const out = execFileSync("git", safeGitArgs(["rev-parse", "--show-toplevel"]), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // git は Windows でも "E:/dev/x" 形式で返すので正規化する
    return out ? resolve(out) : undefined;
  } catch {
    return undefined;
  }
};
