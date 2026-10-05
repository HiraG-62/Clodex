// 実 CLI を使う E2E。サブスクリプションの利用枠を消費するので CLODEX_E2E=1 のときだけ実行する
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "./agent-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";

const E2E_TIMEOUT_MS = 180_000;
const INTERRUPT_DELAY_MS = 3_000;
const CLAUDE_E2E_MODEL = "haiku";

const makeRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "clodex-e2e-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

const scenario = (create: () => AgentAdapter, model?: string) => async () => {
  const cwd = makeRepo();
  const agent = create();
  if (model) await agent.setModel(model);
  await agent.start({ cwd });
  expect(await agent.send("Reply with exactly: PONG")).toEqual({ status: "completed", text: expect.stringContaining("PONG") });

  const long = agent.send("Write the numbers 1 to 500, one per line. Do not use tools.");
  await new Promise((r) => setTimeout(r, INTERRUPT_DELAY_MS));
  await agent.interrupt();
  expect((await long).status).toBe("interrupted");

  const sessionId = agent.sessionId!;
  await agent.stop();
  expect(agent.status).toBe("stopped");

  const resumed = create();
  if (model) await resumed.setModel(model);
  await resumed.start({ cwd, resumeSessionId: sessionId });
  const recall = await resumed.send("What exact word did you reply to my first message? Answer with that word only.");
  expect(recall.text).toContain("PONG");
  await resumed.stop();
};

describe.runIf(process.env.CLODEX_E2E === "1")("Agent adapters (real CLI)", () => {
  it("Claude: 送信・interrupt・停止後の resume", scenario(() => new ClaudeAdapter(), CLAUDE_E2E_MODEL), E2E_TIMEOUT_MS);
  it("Codex: 送信・interrupt・停止後の resume", scenario(() => new CodexAdapter()), E2E_TIMEOUT_MS);
});
