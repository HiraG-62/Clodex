// Spike B: codex app-server (JSON-RPC over stdio) で長寿命 thread + interrupt + resume を確認する
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cwd = process.argv[2] ?? process.cwd();
const resumeId = process.argv[3];

const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let nextId = 1;
const pending = new Map<number, (r: unknown) => void>();
const completed: unknown[] = [];
const QUIET = new Set(["item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "mcpServer/startupStatus/updated"]);

createInterface({ input: child.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && pending.has(m.id)) {
    console.log(ts(), "RESPONSE", m.id, JSON.stringify(m.result ?? m.error).slice(0, 300));
    pending.get(m.id)!(m.result ?? m.error);
    pending.delete(m.id);
    return;
  }
  if (m.id !== undefined) { console.log(ts(), "SERVER REQUEST", m.method, JSON.stringify(m.params).slice(0, 200)); return; }
  if (QUIET.has(m.method)) return;
  if (m.method === "turn/completed") completed.push(m.params);
  const p = m.method === "item/completed" ? JSON.stringify(m.params.item).slice(0, 200) : JSON.stringify(m.params).slice(0, 200);
  console.log(ts(), m.method, p);
});
child.stderr.on("data", (d) => console.log("STDERR", String(d).slice(0, 300)));
child.on("exit", (c) => console.log("exit", c));

const call = (method: string, params: unknown) =>
  new Promise<any>((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
const notify = (method: string, params?: unknown) => child.stdin.write(JSON.stringify({ method, params }) + "\n");
const text = (t: string) => [{ type: "text", text: t, text_elements: [] }];
const waitTurns = async (n: number) => { while (completed.length < n) await sleep(200); };

await call("initialize", { clientInfo: { name: "clodex-spike", title: null, version: "0.0.0" }, capabilities: null });
notify("initialized");
await call("account/read", {});
await call("account/rateLimits/read", undefined);

if (resumeId) {
  const r = await call("thread/resume", { threadId: resumeId });
  await call("turn/start", { threadId: r.thread.id, input: text("What words did you reply in this thread so far? Answer briefly.") });
  await waitTurns(1);
} else {
  const { thread } = await call("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" });
  console.log("THREAD", thread.id);
  await call("turn/start", { threadId: thread.id, input: text("Reply with exactly: ONE") });
  await waitTurns(1);
  await call("turn/start", { threadId: thread.id, input: text("Reply with exactly the word you replied before, then TWO") });
  await waitTurns(2);
  const { turn } = await call("turn/start", { threadId: thread.id, input: text("Write the numbers 1 to 400, one per line. Do not use tools.") });
  await sleep(4000);
  await call("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  await waitTurns(3);
  await call("turn/start", { threadId: thread.id, input: text("Reply with exactly: AFTER-INTERRUPT") });
  await waitTurns(4);
}
child.kill();
process.exit(0);
