#!/usr/bin/env node
// clodex コマンドの入口。部品の組み立てと terminal I/O だけを行う
import { clearLine, createInterface, cursorTo } from "node:readline";
import { ClaudeAdapter } from "./agents/claude-adapter.js";
import { CodexAdapter } from "./agents/codex-adapter.js";
import { parseCliArgs } from "./cli/args.js";
import { createShell } from "./cli/shell.js";
import { Coordinator } from "./coordinator/coordinator.js";
import { EventBus } from "./coordinator/event-bus.js";
import { attachEventLog, defaultLogPath } from "./logging/event-log.js";
import { startMcpServer } from "./mcp/server.js";
import { resolveProjectRoot } from "./project/project-root.js";

const PROMPT = "clodex> ";
const EXIT_FAILURE = 1;
// cleanup 後に何かが残って終わらない場合の保険
const FORCE_EXIT_DELAY_MS = 3_000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  const projectRoot = resolveProjectRoot({ ...(args.project ? { explicitProject: args.project } : {}), cwd: process.cwd() });

  const bus = new EventBus();
  let coordinator: Coordinator | undefined;
  const mcp = await startMcpServer((from, input) => coordinator!.receiveMessage(from, input));
  coordinator = new Coordinator({
    projectRoot,
    agents: { claude: new ClaudeAdapter(), codex: new CodexAdapter() },
    bus,
    mcpUrlFor: (agent) => mcp.urlFor(agent),
    models: args.models,
  });

  const interactive = Boolean(process.stdin.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT, terminal: interactive });
  // 入力途中の行を壊さないよう、プロンプトの上に出力してから入力行を描き直す
  const print = (line: string) => {
    if (!interactive) {
      process.stdout.write(`${line}\n`);
      return;
    }
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(`${line}\n`);
    rl.prompt(true);
  };

  const logPath = defaultLogPath(projectRoot, new Date());
  attachEventLog(bus, { path: logPath, print });
  print(`Clodex v0.1  project: ${projectRoot}`);
  print(`log: ${logPath}`);
  print("Type /help for usage.");

  const shell = createShell({ coordinator, primary: args.primary, print });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    await coordinator.stop();
    await mcp.close();
    // process.exit は出力のフラッシュ前に終了しうるので、自然終了させる
    setTimeout(() => process.exit(0), FORCE_EXIT_DELAY_MS).unref();
  };

  // コマンドの失敗（interrupt の RPC エラー等）でシェルを落とさない
  const report = (error: unknown) => print(`error: ${errorMessage(error)}`);

  rl.on("SIGINT", () => void shell.handleSigint().catch(report));
  rl.on("line", (line) => {
    void shell.handleLine(line)
      .then((outcome) => {
        if (outcome === "exit") return shutdown();
        if (interactive) rl.prompt();
        return undefined;
      })
      .catch(report);
  });
  // 入力の終端（パイプ入力の最後・Ctrl+D）では、受け付けた配送が終わるのを待ってから終了する
  rl.on("close", () => {
    if (shuttingDown) return;
    void coordinator.whenIdle().then(shutdown);
  });
  if (interactive) rl.prompt();
};

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(EXIT_FAILURE);
});
