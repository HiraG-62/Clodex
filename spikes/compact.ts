// Spike G: 手動 compact が効くか確認する
// Claude: stream-json に "/compact" を user メッセージとして送る
// Codex: thread/compact/start
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GROW = "Write a detailed 600-word essay about the history of the Windows operating system. Then reply DONE.";

const claudeSpike = async (cwd: string) => {
  const child = spawn("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku",
  ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let results = 0;
  let lastUsage: Record<string, number> | undefined;
  const contextOf = (u?: Record<string, number>) =>
    u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) : undefined;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const e = JSON.parse(line);
    if (e.type === "assistant" && e.message?.usage) lastUsage = e.message.usage;
    if (e.type === "system" && !["init", "hook_started", "hook_response"].includes(e.subtype)) {
      console.log("claude system", e.subtype, JSON.stringify(e).slice(0, 300));
    }
    if (e.type === "user" && typeof e.message?.content === "string") console.log("claude user echo", e.message.content.slice(0, 200));
    if (e.type === "result") {
      results++;
      console.log("claude result", e.subtype, JSON.stringify(e.result).slice(0, 150), "context:", contextOf(lastUsage));
    }
  });
  const user = (text: string) => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  const waitResults = async (n: number) => { while (results < n) await sleep(200); };

  user("Remember the code word PINEAPPLE. Reply OK.");
  await waitResults(1);
  user(GROW);
  await waitResults(2);
  lastUsage = undefined;
  user("/compact");
  await waitResults(3);
  user("What was the code word? One word.");
  await waitResults(4);
  child.stdin.end();
};

const codexSpike = async (cwd: string) => {
  const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let id = 1;
  const pending = new Map<number, (r: unknown) => void>();
  let completed = 0;
  let lastText = "";
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); return; }
    if (m.method === "thread/tokenUsage/updated") console.log("codex context:", m.params.tokenUsage.last.totalTokens, "total:", m.params.tokenUsage.total.totalTokens);
    if (m.method === "thread/compacted") console.log("codex thread/compacted", JSON.stringify(m.params).slice(0, 200));
    if (m.method === "item/completed" && m.params.item.type === "agentMessage") lastText = m.params.item.text;
    if (m.method === "item/completed" && m.params.item.type !== "agentMessage" && m.params.item.type !== "userMessage") {
      console.log("codex item", m.params.item.type);
    }
    if (m.method === "turn/completed") { completed++; console.log("codex turn", m.params.turn.status, JSON.stringify(lastText).slice(0, 100)); }
  });
  const call = (method: string, params: unknown) => new Promise<any>((res) => {
    const rid = id++; pending.set(rid, res); child.stdin.write(JSON.stringify({ id: rid, method, params }) + "\n");
  });
  const text = (t: string) => [{ type: "text", text: t, text_elements: [] }];
  await call("initialize", { clientInfo: { name: "spike", title: null, version: "0" }, capabilities: null });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const { thread } = await call("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" });

  await call("turn/start", { threadId: thread.id, input: text("Remember the code word PINEAPPLE. Reply OK.") });
  while (completed < 1) await sleep(200);
  await call("turn/start", { threadId: thread.id, input: text(GROW) });
  while (completed < 2) await sleep(200);
  console.log("codex compact/start response:", JSON.stringify(await call("thread/compact/start", { threadId: thread.id })));
  for (let i = 0; i < 300 && completed < 3; i++) await sleep(200);
  console.log("codex turns after compact/start:", completed);
  await call("turn/start", { threadId: thread.id, input: text("What was the code word? One word.") });
  while (completed < 4) await sleep(200);
  child.kill();
};

const which = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "clodex-compact-"));
if (which !== "codex") await claudeSpike(cwd);
if (which !== "claude") await codexSpike(cwd);
process.exit(0);
