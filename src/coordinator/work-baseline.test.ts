import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../protocol/messages.js";
import { WorkBaselines } from "./work-baseline.js";

const request: AgentMessage = {
  id: "r",
  from: "claude",
  to: "codex",
  type: "DELEGATE",
  taskId: "T",
  repository: "",
  createdAt: "",
  body: "実装",
  spec: "spec.md",
};
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "clodex-baseline-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  mkdirSync(join(root, "src"));
  for (const path of ["dirty.txt", "removed.txt", "renamed.txt", "src/a.ts"]) writeFileSync(join(root, path), "base");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "初期化");
  return { root, git, write: (path: string, content = "changed") => writeFileSync(join(root, path), content) };
};

describe("依頼の基準点", () => {
  it("元から dirty な同一内容を除き、commit・削除・rename・未追跡・復元を集める", () => {
    const { root, git, write } = setup();
    write("dirty.txt");
    write("untracked.txt");
    write("src/a.ts", "dirty");
    const baselines = new WorkBaselines(root);
    baselines.start(request);
    write("src/a.ts", "base");
    write("committed.txt");
    git("add", "committed.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "追加");
    unlinkSync(join(root, "removed.txt"));
    renameSync(join(root, "renamed.txt"), join(root, "new name.txt"));
    git("add", "renamed.txt", "new name.txt");
    write("日本語.txt");
    expect(baselines.finish("r")?.changed).toEqual(
      ["committed.txt", "new name.txt", "removed.txt", "renamed.txt", "src/a.ts", "日本語.txt"].sort().map(path => ({ path })),
    );
  });

  it("見出し・glob による範囲と依頼元の編集を付ける", () => {
    const { root, write } = setup();
    const baselines = new WorkBaselines(root, { specSections: { owned: "対象", forbidden: "禁止" } });
    baselines.start(request, "## 対象\n- `src/**`\n## 禁止\n- `src/private.*`\n");
    baselines.record("claude", { type: "tool", name: "Edit", input: "", files: [join(root, "src", "a.ts")] });
    write("src/a.ts");
    write("src/private.ts");
    write("other.txt");
    expect(baselines.finish("r")?.changed).toEqual([
      { path: "other.txt", scope: "outside" },
      { path: "src/a.ts", scope: "owned", peer: true },
      { path: "src/private.ts", scope: "forbidden" },
    ]);
  });

  it("100 件を超えた差分は件数だけにする", () => {
    const { root, write } = setup();
    const baselines = new WorkBaselines(root);
    baselines.start(request);
    for (let i = 0; i < 101; i++) write(`${i}.txt`);
    expect(baselines.finish("r")?.changed).toEqual({ count: 101 });
  });

  it("配送から RESULT までの最後の検査結果を採り、ターンをまたいで保持する", () => {
    const { root } = setup();
    const baselines = new WorkBaselines(root, { verify: { implement: ["pnpm test", "pnpm typecheck", "pnpm lint", "pnpm build"] } });
    const run = (command: string, exitCode?: number) =>
      baselines.record("codex", { type: "tool", name: "command", input: command, command, toolId: command, ...(exitCode === undefined ? {} : { exitCode }) });
    run("pnpm build", 0);
    baselines.start(request);
    run("pnpm test", 1);
    baselines.record("codex", { type: "turn_started" });
    run("pnpm test src/a.test.ts", 0);
    baselines.record("codex", { type: "tool", name: "Bash", input: "", command: "pnpm typecheck", toolId: "bash" });
    baselines.record("codex", { type: "tool_end", toolId: "bash", exitCode: 2 });
    run("pnpm lint");
    baselines.record("codex", { type: "tool_end", toolId: "pnpm lint", failed: true });
    expect(baselines.finish("r")?.checks).toEqual([
      { command: "pnpm test", ran: true, exitCode: 0 },
      { command: "pnpm typecheck", ran: true, exitCode: 2 },
      { command: "pnpm lint", ran: true, failed: true },
      { command: "pnpm build", ran: false },
    ]);
    baselines.start({ ...request, id: "next" });
    expect(baselines.finish("next")?.checks.every(check => !check.ran)).toBe(true);
  });

  it("基準点がない・git の外なら証跡を付けない", () => {
    const root = mkdtempSync(join(tmpdir(), "clodex-no-git-"));
    const baselines = new WorkBaselines(root);
    baselines.start(request);
    expect(baselines.finish("r")).toBeUndefined();
  });
});
