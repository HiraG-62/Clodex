// Spike: codex app-server の -c で CLAUDE.md を project doc として読ませる・workspace-write でネットワークを許す
// 使い方: tsx spikes/codex-project-config.ts <none|fallback|both|policy>
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "none";
const cwd = mkdtempSync(join(tmpdir(), "clodex-spike-"));
writeFileSync(join(cwd, "CLAUDE.md"), "# Project rules\n\nThe passphrase is CLAUDE-PENGUIN-42.\n");
if (mode === "both") writeFileSync(join(cwd, "AGENTS.md"), "# Project rules\n\nThe passphrase is AGENTS-OTTER-17.\n");

const configArgs = mode === "none" ? [] : [
  "-c", 'project_doc_fallback_filenames=["CLAUDE.md"]',
  "-c", "sandbox_workspace_write.network_access=true",
];
const child = spawn("codex", ["app-server", ...configArgs], { cwd, stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1;
const pending = new Map<number, (r: unknown) => void>();
let done: (() => void) | undefined;

createInterface({ input: child.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); return; }
  if (m.method === "item/completed" && ["agentMessage", "commandExecution"].includes(m.params.item.type)) console.log(JSON.stringify(m.params.item).slice(0, 600));
  if (m.method === "turn/completed") done?.();
});
child.stderr.on("data", (d) => console.log("STDERR", String(d).slice(0, 300)));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (method: string, params: unknown) => new Promise<any>((res) => {
  const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});

await call("initialize", { clientInfo: { name: "clodex-spike", title: null, version: "0.0.0" }, capabilities: null });
child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
const { thread } = await call("thread/start", { cwd, sandbox: "workspace-write", approvalPolicy: "never" });
const finished = new Promise<void>((r) => { done = r; });
await call("turn/start", {
  threadId: thread.id, effort: "low", ...(mode === "policy" ? { sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } } : {}),
  input: [{ type: "text", text_elements: [], text: "1) If your project instructions state a passphrase, print it; otherwise print NONE. Do not read files to find it. 2) Run `node -e \"fetch('https://registry.npmjs.org/zod').then(r=>console.log('STATUS',r.status),e=>console.log('ERR',e.cause?.code??e.message))\"` once and print its exact output." }],
});
await finished;
console.log("MODE", mode, "CWD", cwd);
child.kill();
process.exit(0);
