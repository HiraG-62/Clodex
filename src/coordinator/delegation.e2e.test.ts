// 実 CLI での委譲 E2E（DESIGN.md §20 受入条件 4〜10）。CLODEX_E2E=1 のときだけ実行する
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../agents/claude-adapter.js";
import { CodexAdapter } from "../agents/codex-adapter.js";
import { attachEventLog } from "../logging/event-log.js";
import { startMcpServer, type McpServerHandle } from "../mcp/server.js";
import type { AgentMessage } from "../protocol/messages.js";
import { Coordinator } from "./coordinator.js";
import { EventBus } from "./event-bus.js";

const E2E_TIMEOUT_MS = 300_000;
const WAIT_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 500;

const BUGGY_SOURCE = `export const average = (xs: number[]): number => {
  let sum = 0;
  for (let i = 0; i <= xs.length; i++) sum += xs[i];
  return sum / xs.length;
};
`;

const makeRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "clodex-delegation-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "average.ts"), BUGGY_SOURCE);
  return dir;
};

const waitFor = async <T>(probe: () => T | undefined): Promise<T> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const setup = async () => {
  const projectRoot = makeRepo();
  const bus = new EventBus();
  const messages: AgentMessage[] = [];
  bus.subscribe((e) => {
    if (e.kind === "message") messages.push(e.message);
  });
  const logPath = join(projectRoot, "..", `${basename(projectRoot)}.jsonl`);
  attachEventLog(bus, { path: logPath, print: (line) => console.log(line), mode: () => "verbose" });
  let coordinator: Coordinator | undefined;
  const mcp: McpServerHandle = await startMcpServer((from, input) => coordinator!.receiveMessage(from, input));
  coordinator = new Coordinator({
    projectRoot,
    agents: { claude: new ClaudeAdapter(), codex: new CodexAdapter() },
    bus,
    mcpUrlFor: (agent) => mcp.urlFor(agent),
    settings: { claude: { model: "haiku" } },
  });
  cleanup = async () => {
    await coordinator!.stop();
    await mcp.close();
  };
  return { coordinator, messages, logPath };
};

describe.runIf(process.env.CLODEX_E2E === "1")("Delegation (real CLI)", () => {
  it("Claude → Codex の REVIEW_REQUEST に Codex が RESULT を返し、Claude が受け取る", async () => {
    const { coordinator, messages, logPath } = await setup();
    await coordinator.sendToAgent("claude",
      'Use the clodex send_message tool once: to="codex", type="REVIEW_REQUEST", taskId="E2E-1", ' +
      'body="Review average.ts for bugs", files=["average.ts"]. Then end your turn without doing anything else.');

    const request = await waitFor(() => messages.find((m) => m.from === "claude" && m.type === "REVIEW_REQUEST"));
    const reply = await waitFor(() => messages.find((m) => m.from === "codex" && m.replyTo === request.id));
    expect(reply).toMatchObject({ to: "claude", type: "RESULT", taskId: "E2E-1" });

    // RESULT は Claude の新しいターンとして届く。そのターンの完了を待つ
    const claudeTurn = await coordinator.sendToAgent("claude", "Reply with exactly: RECEIVED if you got a RESULT message from codex, otherwise NONE.");
    expect(claudeTurn.text).toContain("RECEIVED");

    // 受入条件 10: message が timestamp / from / to / type / taskId 付きで記録される
    const logged = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(logged).toContainEqual(expect.objectContaining({
      kind: "message", at: expect.any(String),
      message: expect.objectContaining({ id: request.id, from: "claude", to: "codex", type: "REVIEW_REQUEST", taskId: "E2E-1" }),
    }));
  }, E2E_TIMEOUT_MS);

  it("Codex → Claude の QUESTION に Claude が RESULT を返し、Codex が受け取る", async () => {
    const { coordinator, messages } = await setup();
    await coordinator.sendToAgent("codex",
      'Use the clodex send_message tool once: to="claude", type="QUESTION", taskId="E2E-2", ' +
      'body="What does average.ts return for an empty array? Answer briefly.", files=["average.ts"]. Then end your turn.');

    const question = await waitFor(() => messages.find((m) => m.from === "codex" && m.type === "QUESTION"));
    const reply = await waitFor(() => messages.find((m) => m.from === "claude" && m.replyTo === question.id));
    expect(reply).toMatchObject({ to: "codex", type: "RESULT", taskId: "E2E-2" });

    const codexTurn = await coordinator.sendToAgent("codex", "Reply with exactly: RECEIVED if you got a RESULT message from claude, otherwise NONE.");
    expect(codexTurn.text).toContain("RECEIVED");
  }, E2E_TIMEOUT_MS);
});
