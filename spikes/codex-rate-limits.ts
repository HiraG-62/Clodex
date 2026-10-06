// Spike: account/rateLimits/read の生の応答を見る（プランごとの窓の形を確認する。turn は始めないので利用枠は使わない）
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
let nextId = 1;
const pending = new Map<number, (r: unknown) => void>();
createInterface({ input: child.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined || !pending.has(m.id)) return;
  pending.get(m.id)!(m.result ?? m.error);
  pending.delete(m.id);
});
const call = (method: string, params: unknown) =>
  new Promise<unknown>((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });

await call("initialize", { clientInfo: { name: "clodex-spike", title: null, version: "0.0.0" }, capabilities: null });
child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
console.log("account/read", JSON.stringify(await call("account/read", {}), null, 2));
console.log("account/rateLimits/read", JSON.stringify(await call("account/rateLimits/read", undefined), null, 2));
child.kill();
process.exit(0);
