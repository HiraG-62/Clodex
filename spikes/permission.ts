// Spike F: 起動後に権限を変えられるか確認する
// Claude: stream-json の control_request set_permission_mode
// Codex: turn/start の sandboxPolicy
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const claudeSpike = async (cwd: string) => {
  const child = spawn("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku",
    "--permission-mode", "default", "--allow-dangerously-skip-permissions",
  ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const results: Array<{ result: string; denials: unknown }> = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const e = JSON.parse(line);
    if (e.type === "control_response") console.log("claude control_response", JSON.stringify(e.response));
    if (e.type === "system" && e.subtype === "init") console.log("claude init permissionMode:", e.permissionMode);
    if (e.type === "result") results.push({ result: e.result, denials: e.permission_denials });
  });
  const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
  const user = (text: string) => send({ type: "user", message: { role: "user", content: text } });
  const waitResults = async (n: number) => { while (results.length < n) await sleep(200); };

  user("Create a file a.txt containing 'A' using the Write tool. Do not ask, just try.");
  await waitResults(1);
  console.log("default mode:", existsSync(join(cwd, "a.txt")) ? "a.txt CREATED" : "a.txt not created", JSON.stringify(results[0]!.denials).slice(0, 120));

  send({ type: "control_request", request_id: "pm-1", request: { subtype: "set_permission_mode", mode: "acceptEdits" } });
  await sleep(1000);
  user("Create a file b.txt containing 'B' using the Write tool. Do not ask, just try.");
  await waitResults(2);
  console.log("acceptEdits:", existsSync(join(cwd, "b.txt")) ? "b.txt CREATED" : "b.txt not created");

  send({ type: "control_request", request_id: "pm-2", request: { subtype: "set_permission_mode", mode: "bypassPermissions" } });
  await sleep(1000);
  user("Run this exact Bash command: echo C > c.txt");
  await waitResults(3);
  console.log("bypassPermissions:", existsSync(join(cwd, "c.txt")) ? "c.txt CREATED" : "c.txt not created");
  child.stdin.end();
};

const codexSpike = async (cwd: string) => {
  const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let id = 1;
  const pending = new Map<number, (r: any) => void>();
  let completed = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); return; }
    if (m.id !== undefined && m.method) console.log("codex SERVER REQUEST", m.method);
    if (m.method === "turn/completed") completed++;
  });
  const call = (method: string, params: unknown) => new Promise<any>((res) => {
    const rid = id++; pending.set(rid, res); child.stdin.write(JSON.stringify({ id: rid, method, params }) + "\n");
  });
  const text = (t: string) => [{ type: "text", text: t, text_elements: [] }];
  await call("initialize", { clientInfo: { name: "spike", title: null, version: "0" }, capabilities: null });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const { thread } = await call("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" });

  await call("turn/start", { threadId: thread.id, input: text("Create a file d.txt containing 'D' with a shell command. Do not ask.") });
  while (completed < 1) await sleep(200);
  console.log("codex read-only:", existsSync(join(cwd, "d.txt")) ? "d.txt CREATED" : "d.txt not created");

  await call("turn/start", {
    threadId: thread.id,
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    input: text("Now create the file e.txt containing 'E' with a shell command. Do not ask."),
  });
  while (completed < 2) await sleep(200);
  console.log("codex workspaceWrite (per turn):", existsSync(join(cwd, "e.txt")) ? "e.txt CREATED" : "e.txt not created");

  await call("turn/start", { threadId: thread.id, input: text("Create the file f.txt containing 'F' with a shell command. Do not ask.") });
  while (completed < 3) await sleep(200);
  console.log("codex next turn (override persists?):", existsSync(join(cwd, "f.txt")) ? "f.txt CREATED" : "f.txt not created");
  child.kill();
};

const which = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "clodex-perm-"));
if (which !== "codex") await claudeSpike(cwd);
if (which !== "claude") await codexSpike(cwd);
process.exit(0);
