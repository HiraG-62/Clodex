// v0.1 受入シナリオ（DESIGN.md §20）。実際の clodex プロセスを実 CLI で動かす。CLODEX_E2E=1 のときだけ実行する
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoordinatorEvent } from "./coordinator/event-bus.js";

const ACCEPTANCE_TIMEOUT_MS = 600_000;
const WAIT_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 500;
const INTERRUPT_DELAY_MS = 4_000;
const CLODEX_ROOT = resolve(import.meta.dirname, "..");
const TSX_CLI = join(CLODEX_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(CLODEX_ROOT, "src", "index.ts");

const BUGGY_SOURCE = `export const average = (xs: number[]): number => {
  let sum = 0;
  for (let i = 0; i <= xs.length; i++) sum += xs[i];
  return sum / xs.length;
};
`;

const makeRepo = (): { root: string; subdir: string } => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clodex-acceptance-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "average.ts"), BUGGY_SOURCE);
  const subdir = join(root, "src");
  mkdirSync(subdir);
  return { root, subdir };
};

let child: ChildProcessWithoutNullStreams | undefined;
afterEach(() => {
  child?.kill();
  child = undefined;
});

describe.runIf(process.env.CLODEX_E2E === "1")("v0.1 acceptance (real clodex process)", () => {
  it("§20 の受入条件 1〜12", async () => {
    const { root, subdir } = makeRepo();
    // 1. 既存 Git project のサブディレクトリから --project なしで起動できる
    child = spawn(process.execPath, [TSX_CLI, ENTRY, "--claude-model", "haiku"], { cwd: subdir });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((r) => child!.on("exit", r));
    const send = (line: string) => child!.stdin.write(`${line}\n`);
    const waitForOutput = async (pattern: RegExp): Promise<RegExpMatchArray> => {
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      for (;;) {
        const match = output.match(pattern);
        if (match) return match;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}\n--- output ---\n${output}`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    };

    await waitForOutput(/Clodex v0\.1 {2}project: (.+)/);
    expect(output).toContain(`project: ${root}`);
    const logPath = (await waitForOutput(/log: (.+\.jsonl)/))[1]!.trim();

    // 2〜9. Claude → Codex の REVIEW_REQUEST、Codex の RESULT が Claude に届き Claude が継続する
    send('@claude Use the clodex send_message tool once: to="codex", type="REVIEW_REQUEST", taskId="ACC-1", ' +
      'body="Review average.ts for bugs", files=["average.ts"]. Then end your turn.');
    await waitForOutput(/\[MESSAGE\] claude -> codex REVIEW_REQUEST task=ACC-1/);
    await waitForOutput(/\[MESSAGE\] codex -> claude RESULT task=ACC-1/);
    // 3. 両 Agent の出力が識別できる
    expect(output).toMatch(/\[CLAUDE\] /);
    expect(output).toMatch(/\[CODEX\] /);

    // 9. 逆方向: Codex → Claude
    send('@codex Use the clodex send_message tool once: to="claude", type="QUESTION", taskId="ACC-2", ' +
      'body="What does average.ts return for an empty array? Answer briefly.", files=["average.ts"]. Then end your turn.');
    await waitForOutput(/\[MESSAGE\] codex -> claude QUESTION task=ACC-2/);
    await waitForOutput(/\[MESSAGE\] claude -> codex RESULT task=ACC-2/);

    // 11. ユーザーが Agent を interrupt できる（キュー済みの配送が終わるのを待ってから長いターンを始める）
    send("@claude Reply with exactly: READY");
    await waitForOutput(/\[CLAUDE\] READY/);
    send("@claude Write the numbers 1 to 2000, one per line. Do not use tools.");
    await new Promise((r) => setTimeout(r, INTERRUPT_DELAY_MS));
    send("/interrupt claude");
    await waitForOutput(/\[CLAUDE\] turn interrupted/);

    send("/status");
    await waitForOutput(/claude: idle \(session /);

    // 10. message が timestamp / from / to / type / taskId 付きで記録される
    const logged = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as CoordinatorEvent);
    const messages = logged.flatMap((e) => (e.kind === "message" ? [{ ...e.message, at: e.at }] : []));
    for (const m of messages) {
      expect(m).toEqual(expect.objectContaining({
        at: expect.any(String), from: expect.any(String), to: expect.any(String), type: expect.any(String), taskId: expect.any(String),
      }));
    }
    expect(messages.map((m) => m.taskId)).toEqual(expect.arrayContaining(["ACC-1", "ACC-2"]));

    // 12. サブスクリプション認証のまま動作した（Adapter の認証検査で止められていない）
    expect(output).not.toMatch(/not using subscription auth|authentication failed/);

    send("/exit");
    expect(await exited).toBe(0);
  }, ACCEPTANCE_TIMEOUT_MS);
});
