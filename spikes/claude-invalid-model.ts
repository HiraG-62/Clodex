// 不正な --model を付けて -r したときの stream-json の終了形を確認する
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const TIMEOUT_MS = 30000;
const BASE_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--effort", "low"];
const run = (args: string[]) => new Promise<{ sessionId?: string; result?: { is_error?: boolean; subtype?: string; result?: string }; code: number | null; stderr: string }>((resolve) => {
  const child = spawn("claude", [...BASE_ARGS, ...args], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  let sessionId: string | undefined;
  let result: { is_error?: boolean; subtype?: string; result?: string } | undefined;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string; is_error?: boolean; result?: string };
    if (event.type === "system" && event.subtype === "init") sessionId = event.session_id;
    if (event.type === "result") result = { subtype: event.subtype, is_error: event.is_error, result: event.result };
  });
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ sessionId, result, code, stderr: stderr.slice(0, 500) });
  });
  child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: "Reply with exactly ONE." } })}\n`);
});

const first = await run(["--model", "haiku"]);
if (!first.sessionId || !first.result) throw new Error(`initial turn failed: ${JSON.stringify(first)}`);
const resumed = await run(["-r", first.sessionId, "--model", "nonexistent-clodex-model"]);
console.log(JSON.stringify({ initial: { code: first.code, result: first.result }, resumed }));
