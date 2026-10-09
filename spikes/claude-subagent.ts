import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const MAX_RUNTIME_MS = 120_000;
const FINISH_GRACE_MS = 10_000;
const [cwd = process.cwd(), output = "docs/spikes/claude-subagent.raw.jsonl"] = process.argv.slice(2);
const rawPath = resolve(output);
mkdirSync(dirname(rawPath), { recursive: true });
const raw = createWriteStream(rawPath, { flags: "w" });
const child = spawn("claude", [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--model", "haiku", "--effort", "low", "--tools", "Agent,Bash", "--allowedTools", "Agent,Bash",
], { cwd, stdio: ["pipe", "pipe", "pipe"] });

const started = Date.now();
const agentTasks = new Set<string>();
const completed = new Set<string>();
let finishTimer: ReturnType<typeof setTimeout> | undefined;
const stop = () => { if (!child.stdin.destroyed) child.stdin.end(); };
const deadline = setTimeout(stop, MAX_RUNTIME_MS);

createInterface({ input: child.stdout }).on("line", (line) => {
  raw.write(`${line}\n`);
  let event: { type?: string; subtype?: string; task_id?: string; task_type?: string; status?: string; parent_tool_use_id?: string | null; message?: { content?: Array<{ type?: string; name?: string; id?: string; input?: { run_in_background?: boolean } }> } };
  try { event = JSON.parse(line) as typeof event; }
  catch { return; }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (event.type === "system" && event.subtype?.startsWith("task_")) {
    console.log(`${seconds}s ${event.type}/${event.subtype} ${event.task_id ?? ""}`);
    if (event.subtype === "task_started" && event.task_type === "local_agent" && event.task_id) agentTasks.add(event.task_id);
    if (event.subtype === "task_notification" && event.status === "completed" && event.task_id && agentTasks.has(event.task_id)) completed.add(event.task_id);
  }
  if (event.type === "assistant") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use" && block.name === "Agent") {
        console.log(`${seconds}s Agent ${block.id ?? ""} background=${String(block.input?.run_in_background)}`);
      }
    }
  }
  if (event.type === "result") console.log(`${seconds}s result/${event.subtype ?? ""}`);
  if (completed.size >= 2 && !finishTimer) finishTimer = setTimeout(stop, FINISH_GRACE_MS);
});
child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
child.on("close", (code) => {
  clearTimeout(deadline);
  if (finishTimer) clearTimeout(finishTimer);
  raw.end();
  console.log(`exit=${code} raw=${rawPath}`);
  if (code !== 0) process.exitCode = code ?? 1;
});
child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content:
  "Launch exactly two Agent tools with run_in_background=true, in parallel. Use haiku for both. Agent 1: respond exactly QUICK, no tools. Agent 2: use Bash to run 'sleep 8', then respond exactly SLOW. End your own first turn immediately with exactly LAUNCHED. When background agents finish, respond briefly to their completion notifications. Do not launch more agents." } })}\n`);
