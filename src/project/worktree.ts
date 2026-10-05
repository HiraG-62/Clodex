// 並列に動かす会話の作業場所（git worktree）を作る（DESIGN.md §28 D1）。削除・マージは人が git で行う
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";

const SHORT_ID_LENGTH = 8;
const BRANCH_PREFIX = "clodex/";

export interface Worktree {
  workDir: string;
  branch: string;
}

export type WorktreeResult = { ok: true; worktree: Worktree } | { ok: false; error: string };

// <project の隣>/<project 名>-<会話の短い ID>、ブランチ clodex/<会話の短い ID>
export const worktreePlace = (projectRoot: string, conversationId: string): Worktree => {
  const short = conversationId.replace(/[^A-Za-z0-9]/g, "").slice(0, SHORT_ID_LENGTH);
  return { workDir: join(dirname(projectRoot), `${basename(projectRoot)}-${short}`), branch: `${BRANCH_PREFIX}${short}` };
};

export const createWorktree = (projectRoot: string, conversationId: string): Promise<WorktreeResult> => {
  const worktree = worktreePlace(projectRoot, conversationId);
  return new Promise((done) => {
    execFile("git", ["worktree", "add", worktree.workDir, "-b", worktree.branch], { cwd: projectRoot, windowsHide: true },
      (error, _stdout, stderr) => done(error ? { ok: false, error: (stderr || error.message).trim() } : { ok: true, worktree }));
  });
};
