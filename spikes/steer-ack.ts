// Spike: 実行中ターンへの追加入力（steer）を Agent が取り込んだ時点を検知できるか実測する
// 使い方: tsx spikes/steer-ack.ts <claude|codex> <tool|text> [cwd]
//   tool: tool の実行中に steer する / text: tool を使わず長文を書いている最中に steer する
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [agent, scenario, cwdArg] = process.argv.slice(2);
const cwd = cwdArg ?? process.cwd();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const FIRST = scenario === "tool"
  ? "Run the Bash command `sleep 8` three times, one after another, then reply DONE."
  : "Without using any tools, write a 600-word essay about the history of the bicycle.";
const STEER = "Change of plan: stop what you are doing and reply with exactly STEERED.";
const STEER_DELAY_MS = scenario === "tool" ? 6000 : 4000;

const runClaude = async () => {
  const child = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--replay-user-messages", "--model", "haiku", "--allowedTools", "Bash"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let results = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const e = JSON.parse(line);
    if (e.type === "result") {
      results++;
      console.log(ts(), "result", JSON.stringify({ subtype: e.subtype, result: String(e.result).slice(0, 80), num_turns: e.num_turns }));
    } else if (e.type === "user") {
      console.log(ts(), "user", JSON.stringify({ uuid: e.uuid, isReplay: e.isReplay, isSynthetic: e.isSynthetic, content: JSON.stringify(e.message?.content).slice(0, 120) }));
    } else if (e.type === "assistant") {
      console.log(ts(), "assistant", JSON.stringify(e.message.content.map((c: { type: string; text?: string; name?: string }) => (c.text ?? c.name ?? c.type).slice(0, 60))));
    } else if (e.type !== "stream_event") {
      console.log(ts(), e.type, e.subtype ?? "");
    }
  });
  child.stderr.on("data", (d) => console.log("STDERR", String(d).slice(0, 300)));
  const send = (content: string, uuid: string) =>
    child.stdin.write(`${JSON.stringify({ type: "user", uuid, message: { role: "user", content } })}\n`);
  send(FIRST, "00000000-0000-4000-8000-000000000001");
  await sleep(STEER_DELAY_MS);
  console.log(ts(), ">>> steer");
  send(STEER, "00000000-0000-4000-8000-000000000002");
  const deadline = Date.now() + 120_000;
  while (results < 2 && Date.now() < deadline) await sleep(300);
  await sleep(2000);
  child.stdin.end();
};

const runCodex = async () => {
  const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  let completed = 0;
  const pending = new Map<number, (r: unknown) => void>();
  const LOUD = new Set(["turn/started", "turn/completed", "item/started", "item/completed"]);
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) {
      console.log(ts(), "RESPONSE", m.id, JSON.stringify(m.result ?? m.error).slice(0, 200));
      pending.get(m.id)!(m.result ?? { error: m.error });
      pending.delete(m.id);
      return;
    }
    if (m.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ id: m.id, result: { decision: "accept" } })}\n`);
      return;
    }
    if (!LOUD.has(m.method)) return;
    if (m.method === "turn/completed") completed++;
    const item = m.params.item;
    const detail = item ? { type: item.type, id: item.id, content: JSON.stringify(item.content ?? item.text ?? item.command ?? "").slice(0, 100) } : { turn: m.params.turn?.id, status: m.params.turn?.status };
    console.log(ts(), m.method, JSON.stringify(detail));
  });
  child.stderr.on("data", (d) => console.log("STDERR", String(d).slice(0, 300)));
  const call = (method: string, params: unknown) =>
    new Promise<any>((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); });
  const text = (t: string) => [{ type: "text", text: t, text_elements: [] }];
  await call("initialize", { clientInfo: { name: "clodex-spike", title: null, version: "0.0.0" }, capabilities: null });
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const { thread } = await call("thread/start", { cwd, sandbox: "danger-full-access", approvalPolicy: "never" });
  const { turn } = await call("turn/start", { threadId: thread.id, input: text(FIRST) });
  await sleep(STEER_DELAY_MS);
  console.log(ts(), ">>> steer");
  await call("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: text(STEER) });
  const deadline = Date.now() + 120_000;
  while (completed < 1 && Date.now() < deadline) await sleep(300);
  await sleep(2000);
  child.kill();
};

await (agent === "codex" ? runCodex() : runClaude());
process.exit(0);
