// Spike: ある作業ディレクトリで始めた session を、別のディレクトリ（worktree）で resume して会話を続けられるか実測する
// 使い方: tsx spikes/worktree-resume.ts <claude|codex>
//   一時フォルダに A と B を作り、A で合言葉を覚えさせ、B で resume して合言葉と作業ディレクトリを答えさせる
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const agent = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "clodex-wt-resume-"));
const dirA = join(root, "A");
const dirB = join(root, "B");
mkdirSync(dirA);
mkdirSync(dirB);
const FIRST = "Remember the codeword ZEBRA42. Reply with just OK.";
const SECOND = "Without using any tools: what is the codeword, and what is your current working directory according to your environment info? Answer in one line.";

const runClaudeOnce = (cwd: string, args: string[], prompt: string) =>
  new Promise<void>(resolve => {
    const child = spawn("claude", ["-p", "--output-format", "json", "--model", "haiku", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"], shell: true });
    child.stdin.end(prompt);
    let out = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => console.log("STDERR", String(d).slice(0, 300)));
    child.on("close", code => {
      console.log(`[${cwd}] exit=${code}`, (() => { try { const r = JSON.parse(out); return `session=${r.session_id} result=${r.result}`; } catch { return out.slice(0, 400); } })());
      resolve();
    });
  });

const runClaude = async () => {
  const id = randomUUID();
  await runClaudeOnce(dirA, ["--session-id", id], FIRST);
  await runClaudeOnce(dirB, ["-r", id], SECOND);
};

const runCodex = async () => {
  const session = (cwd: string) => {
    const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"], shell: true });
    let nextId = 1;
    const pending = new Map<number, (r: unknown) => void>();
    let done: (() => void) | undefined;
    let lastText = "";
    createInterface({ input: child.stdout }).on("line", line => {
      const m = JSON.parse(line);
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)!(m.result ?? { error: m.error });
        pending.delete(m.id);
        return;
      }
      if (m.method === "item/completed" && m.params.item?.type === "agentMessage") lastText = m.params.item.text;
      if (m.method === "turn/completed") done?.();
    });
    child.stderr.on("data", d => console.log("STDERR", String(d).slice(0, 300)));
    // biome-ignore lint/suspicious/noExplicitAny: spike
    const call = (method: string, params: unknown) => new Promise<any>(res => { const id = nextId++; pending.set(id, res); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); });
    const turn = async (threadId: string, text: string) => {
      const finished = new Promise<void>(r => (done = r));
      await call("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
      await finished;
      return lastText;
    };
    const init = async () => {
      await call("initialize", { clientInfo: { name: "clodex-spike", title: null, version: "0.0.0" }, capabilities: null });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    };
    return { call, turn, init, kill: () => child.kill() };
  };
  const a = session(dirA);
  await a.init();
  const { thread } = await a.call("thread/start", { cwd: dirA, sandbox: "read-only", approvalPolicy: "never" });
  console.log(`[A] thread=${thread.id} cwd=${thread.cwd}`, await a.turn(thread.id, FIRST));
  a.kill();
  const b = session(dirB);
  await b.init();
  const resumed = await b.call("thread/resume", { threadId: thread.id, cwd: dirB, sandbox: "read-only", approvalPolicy: "never" });
  console.log(`[B] resume cwd=${resumed.thread?.cwd ?? JSON.stringify(resumed).slice(0, 200)}`);
  console.log("[B]", await b.turn(thread.id, SECOND));
  b.kill();
};

console.log("A =", dirA, "\nB =", dirB);
await (agent === "codex" ? runCodex() : runClaude());
process.exit(0);
