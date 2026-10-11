import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const MAX_RUNTIME_MS = 90_000;
const FINISH_GRACE_MS = 5_000;
const mode = process.argv[2];
const cwd = process.argv[3] ?? process.cwd();
const output = resolve(process.argv[4] ?? `docs/spikes/background-task-${mode}.raw.jsonl`);
if (mode !== "claude" && mode !== "codex") throw new Error("usage: background-task.ts <claude|codex> [cwd] [output]");
mkdirSync(dirname(output), { recursive: true });
const raw = createWriteStream(output, { flags: "w" });

if (mode === "claude") {
  const child = spawn("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", "haiku", "--effort", "low", "--tools", "Bash", "--allowedTools", "Bash",
  ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let completed = false;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => child.stdin.end(), MAX_RUNTIME_MS);
  createInterface({ input: child.stdout }).on("line", line => {
    raw.write(`${line}\n`);
    const event = JSON.parse(line) as { type?: string; subtype?: string; task_id?: string; task_type?: string; status?: string; tasks?: unknown[] };
    if (event.type === "system" && (event.subtype?.startsWith("task_") || event.subtype === "background_tasks_changed")) {
      console.log(`${event.subtype} ${event.task_id ?? ""} ${event.task_type ?? ""} ${event.status ?? ""} ${event.tasks?.length ?? ""}`);
    }
    if (event.subtype === "task_notification" && event.status === "completed") completed = true;
    if (event.type === "result") {
      console.log(`result ${event.subtype ?? ""}`);
      if (completed && !finishTimer) finishTimer = setTimeout(() => child.stdin.end(), FINISH_GRACE_MS);
    }
  });
  child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
  child.on("close", code => {
    clearTimeout(deadline);
    if (finishTimer) clearTimeout(finishTimer);
    raw.end();
    console.log(`exit=${code} raw=${output}`);
    if (code !== 0) process.exitCode = code ?? 1;
  });
  child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content:
    "Call the Bash tool now with input {\"command\":\"sleep 12\",\"run_in_background\":true}. This is a tool execution test; do not claim to have launched it without an actual Bash tool call. After the tool call, end the first turn with LAUNCHED. When its background completion arrives, reply briefly. Do not call any other tool." } })}\n`);
} else {
  const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  const pending = new Map<number, (value: { result?: unknown; error?: unknown }) => void>();
  let turnDone: (() => void) | undefined;
  createInterface({ input: child.stdout }).on("line", line => {
    raw.write(`${line}\n`);
    const event = JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
    if (event.id !== undefined && pending.has(event.id)) {
      pending.get(event.id)?.(event);
      pending.delete(event.id);
    }
    if (event.method === "turn/completed") turnDone?.();
    if (event.method && /process|command|terminal|turn\/completed|item\/started|item\/completed/.test(event.method)) console.log(event.method);
  });
  child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
  const call = async (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const reply = new Promise<{ result?: unknown; error?: unknown }>(resolve => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const value = await reply;
    if (value.error) throw new Error(`${method}: ${JSON.stringify(value.error)}`);
    return value.result;
  };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = setTimeout(() => child.kill(), MAX_RUNTIME_MS);
  try {
    await call("initialize", { clientInfo: { name: "clodex-background-spike", title: null, version: "0.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const started = await call("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" }) as { thread: { id: string } };
    const threadId = started.thread.id;
    console.log(`thread=${threadId}`);
    const completed = new Promise<void>(resolve => { turnDone = resolve; });
    await call("turn/start", { threadId, input: [{ type: "text", text: "Use exec_command to run a 12-second sleep with yield_time_ms=1000, then finish your turn without waiting for it. This is a background terminal lifecycle test. Do not poll the command.", text_elements: [] }] });
    await completed;
    console.log(`after_turn=${JSON.stringify(await call("thread/backgroundTerminals/list", { threadId }))}`);
    await wait(15_000);
    console.log(`after_wait=${JSON.stringify(await call("thread/backgroundTerminals/list", { threadId }))}`);
  } finally {
    clearTimeout(deadline);
    child.kill();
    raw.end();
    console.log(`raw=${output}`);
  }
}
