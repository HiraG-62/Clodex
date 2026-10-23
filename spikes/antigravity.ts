// Antigravity CLI（agy）の headless を実測する（結果は docs/spikes/antigravity.md）
// 実行はターンごとに Google AI プランの利用枠を消費する。モデルは軽い flash-low を使う
// usage: tsx spikes/antigravity.ts <single|multi|resume|plan|mcp> [conversationId]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = process.argv[2];
const MODEL = "gemini-3.8-flash-low";
const AGY = join(process.env.LOCALAPPDATA ?? "", "agy", "bin", "agy.exe");
const TIMEOUT_MS = 180_000;

const run = (args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const result = spawnSync(AGY, args, {
    cwd: options.cwd ?? process.cwd(),
    input: options.input,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  console.log(`exit=${result.status}`);
  console.log(result.stdout);
  if (result.stderr) console.error(`--- stderr\n${result.stderr.slice(0, 1000)}`);
  return result.stdout;
};
const stream = ["--model", MODEL, "--output-format", "stream-json"];

if (probe === "single") {
  // 単発ターン: init / step_update / result の NDJSON
  run(["-p", "Reply with exactly: pong", ...stream]);
} else if (probe === "multi") {
  // 1 プロセス複数ターン: stdin に 1 行 1 JSON。init は 1 回、ターンごとに result（usage は累積）
  const lines = ['{"event":"user","message":{"content":"Reply with exactly: one"}}', '{"event":"user","message":{"content":"Reply with exactly: two"}}'];
  run(["--input-format", "stream-json", ...stream], { input: `${lines.join("\n")}\n` });
} else if (probe === "resume") {
  // 別プロセスでの再開: 事前に single を実行し、その conversation_id を渡す
  const id = process.argv[3];
  if (!id) throw new Error("usage: tsx spikes/antigravity.ts resume <conversationId>");
  run(["-p", "What exact word did I ask you to reply with? Answer with that word only.", "--conversation", id, "--model", MODEL, "--output-format", "json"]);
} else if (probe === "plan") {
  // --mode plan ではファイルを作らない（init.permission_mode は request-review のまま）
  const dir = mkdtempSync(join(tmpdir(), "agy-spike-plan-"));
  run(["-p", "Create a file named t1.txt containing exactly: hi", "--mode", "plan", "--model", MODEL, "--output-format", "json"], { cwd: dir });
} else if (probe === "mcp") {
  // workspace の .agents/mcp_config.json の stdio サーバーが使われ、agy の env が MCP の子プロセスへ引き継がれる
  const dir = mkdtempSync(join(tmpdir(), "agy-spike-mcp-"));
  writeFileSync(
    join(dir, "test-mcp.cjs"),
    [
      'const readline = require("node:readline");',
      "const rl = readline.createInterface({ input: process.stdin });",
      'const send = obj => process.stdout.write(JSON.stringify(obj) + "\\n");',
      'rl.on("line", line => {',
      "  let msg; try { msg = JSON.parse(line); } catch { return; }",
      '  if (msg.method === "initialize")',
      '    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "clodex-test", version: "1.0.0" } } });',
      '  else if (msg.method === "tools/list")',
      '    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo_env", description: "Returns the CLODEX_MCP_URL environment variable.", inputSchema: { type: "object", properties: {} } }] } });',
      '  else if (msg.method === "tools/call")',
      '    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "CLODEX_MCP_URL=" + (process.env.CLODEX_MCP_URL ?? "unset") }] } });',
      "  else if (msg.id !== undefined) send({ jsonrpc: \"2.0\", id: msg.id, result: {} });",
      "});",
    ].join("\n"),
  );
  mkdirSync(join(dir, ".agents"));
  writeFileSync(join(dir, ".agents", "mcp_config.json"), JSON.stringify({ mcpServers: { clodex: { command: "node", args: ["test-mcp.cjs"] } } }));
  run(["-p", "Call the echo_env tool of the clodex MCP server and reply with its output verbatim.", ...stream, "--dangerously-skip-permissions"], {
    cwd: dir,
    env: { CLODEX_MCP_URL: "http://127.0.0.1:9999/mcp/test-token" },
  });
} else {
  throw new Error("usage: tsx spikes/antigravity.ts <single|multi|resume|plan|mcp> [conversationId]");
}
