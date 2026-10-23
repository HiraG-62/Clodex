import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../protocol/messages.js";
import { isStandaloneCheck, WorkBaselines } from "./work-baseline.js";

const CHECK_COMMAND = "pnpm run check:anim";

describe("検査の単独実行", () => {
  it.each([
    CHECK_COMMAND,
    `${CHECK_COMMAND} --verbose`,
    `${CHECK_COMMAND} 2>&1`,
    `${CHECK_COMMAND} > result.txt`,
    `cd /e/dev/x; ${CHECK_COMMAND}`,
    `cd '/e/dev/my project' && cd child; ${CHECK_COMMAND}`,
    `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '${CHECK_COMMAND}'`,
    `powershell.exe -Command "${CHECK_COMMAND}"`,
    `pwsh -Command 'cd /e/dev/x; ${CHECK_COMMAND} 2>&1'`,
    `cd /e/dev/x && bash -lc '${CHECK_COMMAND}'`,
    `sh -c '${CHECK_COMMAND}'`,
  ])("単独として扱う: %s", command => {
    expect(isStandaloneCheck(command, CHECK_COMMAND)).toBe(true);
  });

  it.each([
    `${CHECK_COMMAND} 2>&1 | grep -E "x"`,
    `sed -i file; ${CHECK_COMMAND}`,
    `${CHECK_COMMAND} && echo ok`,
    `${CHECK_COMMAND} || echo failed`,
    `${CHECK_COMMAND}; echo ok`,
    `pwsh -Command '${CHECK_COMMAND} | Select-String x'`,
    `pwsh -Command '${CHECK_COMMAND}' && echo ok`,
    `echo '${CHECK_COMMAND}'`,
    `${CHECK_COMMAND}:other`,
  ])("単独として扱わない: %s", command => {
    expect(isStandaloneCheck(command, CHECK_COMMAND)).toBe(false);
  });
});

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
  const raw = mkdtempSync(join(tmpdir(), "clodex-baseline-"));
  const root = realpathSync.native(raw);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  mkdirSync(join(root, "src"));
  for (const path of ["dirty.txt", "removed.txt", "renamed.txt", "src/a.ts"]) writeFileSync(join(root, path), "base");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "初期化");
  return { raw, root, git, write: (path: string, content = "changed") => writeFileSync(join(root, path), content) };
};

describe("依頼の基準点", () => {
  it("本体の中の ignored worktree を依頼ごとに選び、範囲と peer を相対化する", () => {
    const { raw, root, git, write } = setup();
    write(".gitignore", ".claude/\n");
    const worktree = join(root, ".claude", "worktrees", "task");
    git("worktree", "add", "--detach", worktree);
    writeFileSync(join(worktree, "spec.md"), "## 対象\n- `src/**`\n");
    const baselines = new WorkBaselines(raw, { specSections: { owned: "対象" } });
    baselines.start({ ...request, spec: ".claude/worktrees/task/spec.md" }, "## 対象\n- `src/**`\n");
    baselines.start({ ...request, id: "main", spec: undefined });
    baselines.recordPeerFiles("claude", [".claude/worktrees/task/src/a.ts", join(root, "src", "other.ts")]);
    writeFileSync(join(worktree, "src", "a.ts"), "changed");
    writeFileSync(join(worktree, "src", "other.ts"), "changed");
    expect(baselines.finish("r")).toMatchObject({
      root: worktree,
      changed: [
        { path: "src/a.ts", scope: "owned", peer: true },
        { path: "src/other.ts", scope: "owned" },
      ],
    });
    expect(baselines.finish("main")).toMatchObject({ root, changed: [] });
  });

  it("同じ作業ツリーの spec と存在しない spec は会話の場所を保つ", () => {
    const { root, write } = setup();
    write("spec.md", "設計");
    const baselines = new WorkBaselines(root);
    baselines.start(request);
    baselines.start({ ...request, id: "missing", spec: "missing/spec.md" });
    expect(baselines.finish("r")).toMatchObject({ root, changed: [] });
    expect(baselines.finish("missing")).toMatchObject({ root, changed: [] });
  });

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

  it("設定の文字列で始まる見出しを範囲の節とみなす", () => {
    const { root, write } = setup();
    const baselines = new WorkBaselines(root, { specSections: { owned: "所有ファイル", forbidden: "編集禁止" } });
    baselines.start(request, "## 所有ファイル（自由に編集してよい）\n- `src/**`\n## 編集禁止（読むのは OK）\n- `src/private.*`\n");
    write("src/a.ts");
    write("src/private.ts");
    expect(baselines.finish("r")?.changed).toEqual([
      { path: "src/a.ts", scope: "owned" },
      { path: "src/private.ts", scope: "forbidden" },
    ]);
  });

  it("編集禁止の説明にある「以外」を範囲に含めない", () => {
    const { root, write } = setup();
    mkdirSync(join(root, "src/system"), { recursive: true });
    mkdirSync(join(root, "src/map/layout"), { recursive: true });
    const baselines = new WorkBaselines(root, { specSections: { owned: "所有", forbidden: "編集禁止" } });
    baselines.start(
      request,
      "## 所有\n- `src/**/*.test.ts`\n## 編集禁止\n- 本体（`*.test.ts` 以外）すべて。`src/map/layout/**` は並行の B2c が worktree で編集中\n",
    );
    write("src/system/foo.test.ts");
    write("src/map/layout/a.ts");
    write("foo.test.ts");
    expect(baselines.finish("r")?.changed).toEqual([
      { path: "foo.test.ts", scope: "outside" },
      { path: "src/map/layout/a.ts", scope: "forbidden" },
      { path: "src/system/foo.test.ts", scope: "owned" },
    ]);
  });

  it.each(["`!src/private.*`", "`src/private.*`以外", "`src/private.*` 以外", "`src/private.*`　以外"])(
    "owned と forbidden の両方で除外を範囲から引く: %s",
    exception => {
      const { root, write } = setup();
      const baselines = new WorkBaselines(root, { specSections: { owned: "所有", forbidden: "禁止" } });
      baselines.start(request, `## 所有\n- \`src/**\`\n- ${exception}\n## 禁止\n- \`src/**\`\n- ${exception}\n`);
      write("src/a.ts");
      write("src/private.ts");
      expect(baselines.finish("r")?.changed).toEqual([
        { path: "src/a.ts", scope: "forbidden" },
        { path: "src/private.ts", scope: "outside" },
      ]);
    },
  );

  it.each(["所有", "禁止"])("除外だけの節は全体から引き、空の節は範囲を増やさない: %s", heading => {
    const { root, write } = setup();
    const baselines = new WorkBaselines(root, { specSections: { owned: "所有", forbidden: "禁止" } });
    baselines.start(request, `## 所有\n## 禁止\n## ${heading}\n- \`!**/*.test.ts\`\n`);
    write("src/a.ts");
    write("src/a.test.ts");
    write("other.txt");
    expect(baselines.finish("r")?.changed).toEqual([
      { path: "other.txt", scope: heading === "所有" ? "owned" : "forbidden" },
      { path: "src/a.test.ts", scope: "outside" },
      { path: "src/a.ts", scope: heading === "所有" ? "owned" : "forbidden" },
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

  it.each(["command", "Bash"])("%s のつないだ実行は tool_end でも結果不明のままにする", name => {
    const { root } = setup();
    const baselines = new WorkBaselines(root, { verify: { implement: [CHECK_COMMAND] } });
    baselines.start(request);
    baselines.record("codex", { type: "tool", name, input: "", command: `${CHECK_COMMAND} | grep x`, toolId: "pipe", exitCode: 1 });
    baselines.record("codex", { type: "tool_end", toolId: "pipe", exitCode: 1, failed: true });
    expect(baselines.finish("r")?.checks).toEqual([{ command: CHECK_COMMAND, ran: true }]);
  });

  it.each([true, false])("単独の実行は後のパイプで上書きせず、その tool_end を反映する: 完了済み=%s", completed => {
    const { root } = setup();
    const baselines = new WorkBaselines(root, { verify: { implement: [CHECK_COMMAND] } });
    baselines.start(request);
    baselines.record("codex", { type: "tool", name: "command", input: CHECK_COMMAND, toolId: "single", ...(completed ? { exitCode: 0 } : {}) });
    baselines.record("codex", { type: "tool", name: "command", input: `${CHECK_COMMAND} | grep x`, toolId: "pipe", exitCode: 1 });
    baselines.record("codex", { type: "tool_end", toolId: "pipe", exitCode: 1, failed: true });
    if (!completed) baselines.record("codex", { type: "tool_end", toolId: "single", exitCode: 0 });
    expect(baselines.finish("r")?.checks).toEqual([{ command: CHECK_COMMAND, ran: true, exitCode: 0 }]);
  });

  it("つないだ実行の後の単独実行を採り、さらに単独実行したら前の失敗を消す", () => {
    const { root } = setup();
    const baselines = new WorkBaselines(root, { verify: { implement: [CHECK_COMMAND] } });
    baselines.start(request);
    baselines.record("codex", { type: "tool", name: "command", input: `${CHECK_COMMAND} && echo ok`, toolId: "chain", exitCode: 0 });
    baselines.record("codex", { type: "tool", name: "command", input: CHECK_COMMAND, toolId: "failed" });
    baselines.record("codex", { type: "tool_end", toolId: "failed", exitCode: 1, failed: true });
    baselines.record("codex", { type: "tool", name: "command", input: CHECK_COMMAND, exitCode: 0 });
    baselines.record("codex", { type: "tool", name: "command", input: `${CHECK_COMMAND} | grep x`, exitCode: 1 });
    baselines.record("codex", { type: "tool_end", toolId: "failed", exitCode: 1, failed: true });
    expect(baselines.finish("r")?.checks).toEqual([{ command: CHECK_COMMAND, ran: true, exitCode: 0 }]);
  });

  it("基準点がない・git の外なら証跡を付けない", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "clodex-no-git-")));
    const baselines = new WorkBaselines(root);
    baselines.start(request);
    expect(baselines.finish("r")).toBeUndefined();
  });
});
