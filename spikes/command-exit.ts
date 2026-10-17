import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const MAX_RUNTIME_MS = 120_000;
const mode = process.argv[2];
const cwd = process.argv[3] ?? process.cwd();
const output = resolve(process.argv[4] ?? `docs/spikes/command-exit-${mode}.raw.jsonl`);
if (mode !== "claude" && mode !== "codex") throw new Error("usage: command-exit.ts <claude|codex> [cwd] [output]");
mkdirSync(dirname(output), { recursive: true });
const raw = createWriteStream(output);
const args = mode === "claude"
  ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--effort", "low", "--tools", "Bash", "--allowedTools", "Bash"]
  : ["app-server"];
const child = spawn(mode, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
const deadline = setTimeout(() => { process.exitCode = 1; child.kill(); }, MAX_RUNTIME_MS);
const closed = new Promise<void>(resolve => child.on("close", code => {
  clearTimeout(deadline);
  raw.end();
  console.log(`exit=${code} raw=${output}`);
  if (mode === "claude" && code !== 0) process.exitCode = code ?? 1;
  resolve();
}));
child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextId = 1;
let finishTurn: (() => void) | undefined;
createInterface({ input: child.stdout }).on("line", line => {
  raw.write(`${line}\n`);
  const event = JSON.parse(line) as { id?: number; method?: string; type?: string; result?: unknown; error?: unknown };
  if (event.id !== undefined) {
    const request = pending.get(event.id);
    pending.delete(event.id);
    if (event.error) request?.reject(new Error(JSON.stringify(event.error)));
    else request?.resolve(event.result);
  }
  if (event.method === "turn/completed") finishTurn?.();
  if (mode === "claude" && event.type === "result") child.stdin.end();
});
const call = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
});

if (mode === "claude") {
  const prompt = 'Execute exactly two foreground Bash calls: first {"command":"exit 0"}, then {"command":"exit 3"}. This tests tool result metadata. Do not retry failures or call other tools. After both calls reply DONE.';
  child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
} else {
  try {
    await call("initialize", { clientInfo: { name: "clodex-command-exit-spike", title: null, version: "0.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const started = await call("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" }) as { thread: { id: string } };
    const completed = new Promise<void>(resolve => { finishTurn = resolve; });
    await call("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Execute exactly one exec_command call with cmd=exit 3. This tests the exit code. Do not retry or call other tools. Then reply DONE.", text_elements: [] }] });
    await completed;
  } finally {
    child.kill();
  }
}
await closed;
