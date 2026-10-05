// Spike A: claude -p --input-format stream-json で長寿命 session + interrupt を確認する
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cwd = process.argv[2] ?? process.cwd();
const background = process.argv.includes("--background");

const child = spawn(
  "claude",
  ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku",
    ...(background ? ["--allowedTools", "Agent"] : [])],
  { cwd, stdio: ["pipe", "pipe", "pipe"] },
);
const t0 = Date.now();
const results: unknown[] = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  const e = JSON.parse(line);
  const tag = `${((Date.now() - t0) / 1000).toFixed(1)}s ${e.type}/${e.subtype ?? ""}`;
  if (e.type === "result") { results.push(e); console.log(tag, JSON.stringify({ result: e.result, is_error: e.is_error })); }
  else if (e.type === "control_response") console.log(tag, JSON.stringify(e.response));
  else if (e.type === "assistant") console.log(tag, JSON.stringify({
    parent_tool_use_id: e.parent_tool_use_id,
    content: e.message.content.map((c: { type: string; text?: string; name?: string; input?: unknown }) =>
      ({ type: c.type, value: c.text ?? c.name ?? c.type, input: c.input })),
  }).slice(0, 800));
  else if (background || e.type !== "system" || e.subtype === "init") console.log(tag, JSON.stringify({ subtype: e.subtype, parent_tool_use_id: e.parent_tool_use_id }));
});
child.stderr.on("data", (d) => console.log("STDERR", String(d)));
child.on("exit", (code) => console.log("exit", code));

const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
const user = (text: string) => send({ type: "user", message: { role: "user", content: text } });

if (background) {
  user("Use the Agent tool with run_in_background=true to ask a haiku subagent to reply with exactly BACKGROUND-DONE after a short pause. End your own turn immediately after launching it. When the subagent finishes, reply with exactly PARENT-DONE without waiting for another user message.");
  while (results.length < 2) await sleep(200);
  child.stdin.end();
} else {
user("Reply with exactly: ONE");
while (results.length < 1) await sleep(200);
user("Reply with exactly the word you replied before, then TWO");
while (results.length < 2) await sleep(200);
user("Count slowly from 1 to 300, one number per line, no shortcuts.");
await sleep(4000);
send({ type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } });
while (results.length < 3) await sleep(200);
user("Reply with exactly: AFTER-INTERRUPT");
while (results.length < 4) await sleep(200);
child.stdin.end();
}
