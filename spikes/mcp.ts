// Spike D: Coordinator が MCP server を持ち、Claude / Codex が tool 呼び出しで formal message を送れるか確認する
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cwd = process.argv[2] ?? process.cwd();
const received: unknown[] = [];

// 送信元は URL path で決定論的に識別する（Agent の自己申告に頼らない）
const buildServer = (from: string) => {
  const server = new McpServer({ name: "clodex", version: "0.0.0" });
  server.registerTool(
    "send_message",
    {
      description: "Send a formal message to another agent via the Clodex coordinator.",
      inputSchema: {
        to: z.enum(["claude", "codex"]),
        type: z.enum(["QUESTION", "REVIEW_REQUEST", "DELEGATE", "RESULT", "ISSUE", "ACK"]),
        taskId: z.string(),
        objective: z.string(),
        files: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const msg = { id: `msg_${received.length + 1}`, from, at: new Date().toISOString(), ...args };
      received.push(msg);
      console.log("RECEIVED", JSON.stringify(msg));
      return { content: [{ type: "text", text: `queued ${msg.id}` }] };
    },
  );
  return server;
};

const http = createServer(async (req, res) => {
  const from = req.url?.match(/^\/mcp\/(claude|codex)$/)?.[1];
  if (!from) { res.writeHead(404).end(); return; }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => void transport.close());
  await buildServer(from).connect(transport);
  await transport.handleRequest(req, res);
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
console.log("MCP at", base);

const PROMPT = (to: string) =>
  `Use the clodex send_message tool exactly once with to="${to}", type="REVIEW_REQUEST", taskId="SPIKE-1", objective="spike test", files=["README.md"]. Then reply DONE.`;

// --- Claude ---
const runClaude = () => new Promise<void>((resolve) => {
  const mcpConfig = JSON.stringify({ mcpServers: { clodex: { type: "http", url: `${base}/claude` } } });
  const c = spawn("claude", ["-p", PROMPT("codex"), "--model", "haiku", "--output-format", "stream-json", "--verbose",
    "--mcp-config", mcpConfig, "--allowedTools", "mcp__clodex__send_message"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  createInterface({ input: c.stdout }).on("line", (l) => {
    const e = JSON.parse(l);
    if (e.subtype === "init") console.log("claude init mcp:", JSON.stringify(e.mcp_servers.filter((s: { name: string }) => s.name === "clodex")));
    if (e.type === "result") console.log("claude result:", e.result, e.permission_denials);
  });
  c.on("exit", () => resolve());
});

// --- Codex ---
const runCodex = () => new Promise<void>((resolve) => {
  const c = spawn("codex", ["app-server", "-c", `mcp_servers.clodex.url="${base}/codex"`, "-c", `mcp_servers.clodex.default_tools_approval_mode="approve"`], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let id = 1;
  const send = (method: string, params?: unknown, isNotify = false) =>
    c.stdin.write(JSON.stringify(isNotify ? { method, params } : { id: id++, method, params }) + "\n");
  createInterface({ input: c.stdout }).on("line", async (l) => {
    const m = JSON.parse(l);
    if (m.id === 1) { send("initialized", undefined, true); send("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" }); }
    if (m.id === 2) send("turn/start", { threadId: m.result.thread.id, input: [{ type: "text", text: PROMPT("claude"), text_elements: [] }] });
    if (m.method && m.id !== undefined) console.log("codex SERVER REQUEST", m.method, JSON.stringify(m.params).slice(0, 300));
    if (m.method === "item/completed" && m.params.item.type === "mcpToolCall") console.log("codex mcpToolCall:", JSON.stringify({status:m.params.item.status,error:m.params.item.error,result:m.params.item.result}));
    if (m.method === "mcpServer/startupStatus/updated") console.log("codex mcp status:", JSON.stringify(m.params));
    if (m.method === "turn/completed") { console.log("codex turn:", m.params.turn.status); c.kill(); resolve(); }
  });
  send("initialize", { clientInfo: { name: "clodex-spike", title: null, version: "0.0.0" }, capabilities: null });
});

await runClaude();
await runCodex();
await sleep(200);
console.log("TOTAL RECEIVED", received.length);
process.exit(0);
