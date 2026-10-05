// Spike（v0.3 C）: 実行中ターンへの追加入力（steer）、画像の入力、Codex の subagent を実測する
// 使い方: tsx spikes/steer-image-subagent.ts <claude|codex> <steer|image|subagent> [cwd]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { deflateSync } from "node:zlib";

const [agent, scenario, cwdArg] = process.argv.slice(2);
const cwd = cwdArg ?? process.cwd();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// 赤一色の 16x16 PNG を作る（色を答えさせて、画像が届いたかを確かめる）
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const SIZE = 16;
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const rows = Buffer.concat(Array.from({ length: SIZE }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(SIZE * 3, Buffer.from([255, 0, 0]))])));
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
]);
const RED_PNG_BASE64 = png.toString("base64");
const imagePath = join(tmpdir(), "clodex-spike-red.png");
writeFileSync(imagePath, png);

const runClaude = async () => {
  const child = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku",
    "--allowedTools", "Bash"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const results: unknown[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const e = JSON.parse(line);
    if (e.type === "result") results.push(e);
    if (e.type === "assistant") {
      console.log(ts(), "assistant", JSON.stringify(e.message.content.map((c: { type: string; text?: string; name?: string; input?: unknown }) => c.text ?? `${c.name ?? c.type} ${JSON.stringify(c.input ?? "")}`)).slice(0, 300));
    } else if (e.type === "user") {
      console.log(ts(), "user(echo)", JSON.stringify(e.message?.content).slice(0, 200));
    } else if (e.type === "result") {
      console.log(ts(), "result", JSON.stringify({ subtype: e.subtype, result: e.result, is_error: e.is_error, num_turns: e.num_turns }));
    } else if (e.type === "system") {
      console.log(ts(), "system", e.subtype);
    }
  });
  child.stderr.on("data", (d) => console.log("STDERR", String(d).slice(0, 300)));
  const send = (content: unknown) => child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
  if (scenario === "steer") {
    send("Run the Bash command `sleep 8` three times, one after another, then reply DONE.");
    await sleep(6000);
    console.log(ts(), ">>> steer");
    send("Change of plan: stop running commands and reply with exactly STEERED.");
    while (results.length < 2) await sleep(300);
  } else if (scenario === "image") {
    send([
      { type: "image", source: { type: "base64", media_type: "image/png", data: RED_PNG_BASE64 } },
      { type: "text", text: "What single color is this image? Reply with one word." },
    ]);
    while (results.length < 1) await sleep(300);
  }
  child.stdin.end();
};

const runCodex = async () => {
  const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  const pending = new Map<number, (r: unknown) => void>();
  const completed: Array<{ threadId?: string }> = [];
  const QUIET = new Set(["item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "mcpServer/startupStatus/updated",
    "item/commandExecution/outputDelta", "thread/tokenUsage/updated", "account/rateLimits/updated"]);
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) {
      console.log(ts(), "RESPONSE", m.id, JSON.stringify(m.result ?? m.error).slice(0, 300));
      pending.get(m.id)!(m.result ?? { error: m.error });
      pending.delete(m.id);
      return;
    }
    if (m.id !== undefined) {
      console.log(ts(), "SERVER REQUEST", m.method, JSON.stringify(m.params).slice(0, 300));
      child.stdin.write(`${JSON.stringify({ id: m.id, result: { decision: "accept" } })}\n`);
      return;
    }
    if (QUIET.has(m.method)) return;
    if (m.method === "turn/completed") completed.push(m.params);
    const params = m.method.startsWith("item/") ? { threadId: m.params.threadId, item: m.params.item } : m.params;
    console.log(ts(), m.method, JSON.stringify(params).slice(0, 400));
  });
  child.stderr.on("data", (d) => console.log("STDERR", String(d).slice(0, 300)));
  const call = (method: string, params: unknown) =>
    new Promise<any>((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); });
  const text = (t: string) => ({ type: "text", text: t, text_elements: [] });
  await call("initialize", { clientInfo: { name: "clodex-spike", title: null, version: "0.0.0" }, capabilities: null });
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const { thread } = await call("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" });
  const main = thread.id;
  console.log("THREAD", main);
  const mainTurns = () => completed.filter((c) => c.threadId === main).length;
  if (scenario === "steer") {
    const { turn } = await call("turn/start", { threadId: main, input: [text("Run the shell command `sleep 8` three times, one after another, then reply DONE.")] });
    await sleep(6000);
    console.log(ts(), ">>> steer");
    await call("turn/steer", { threadId: main, expectedTurnId: turn.id, input: [text("Change of plan: stop running commands and reply with exactly STEERED.")] });
    while (mainTurns() < 1) await sleep(300);
  } else if (scenario === "image") {
    await call("turn/start", { threadId: main, input: [{ type: "localImage", path: imagePath }, text("What single color is this image? Reply with one word.")] });
    while (mainTurns() < 1) await sleep(300);
  } else if (scenario === "subagent") {
    await call("turn/start", { threadId: main, input: [text("Spawn one sub-agent and ask it to reply with exactly SUB-DONE. Wait for it, then reply with exactly PARENT-DONE.")] });
    while (mainTurns() < 1) await sleep(300);
    await sleep(2000);
  }
  child.kill();
};

await (agent === "codex" ? runCodex() : runClaude());
process.exit(0);
