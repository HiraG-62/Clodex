// model の一覧を API 呼び出しなしで取得できるかを実測する（Claude: control_request initialize、Codex: model/list）
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const agent = process.argv[2];
const TIMEOUT_MS = 30_000;
if (agent !== "claude" && agent !== "codex") throw new Error("usage: tsx spikes/model-list.ts <claude|codex>");
const child = spawn(agent, agent === "claude"
  ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
  : ["app-server"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], shell: true });
child.stderr.on("data", (chunk) => console.error(String(chunk).slice(0, 300)));
const write = (event: unknown) => child.stdin.write(`${JSON.stringify(event)}\n`);
const timer = setTimeout(() => { console.error("timeout"); child.kill(); }, TIMEOUT_MS);
const finish = () => { clearTimeout(timer); child.kill(); };

createInterface({ input: child.stdout }).on("line", (line) => {
  const event = JSON.parse(line) as Record<string, unknown>;
  if (agent === "claude" && event.type === "control_response") {
    const response = (event.response ?? {}) as { response?: Record<string, unknown> };
    console.log(JSON.stringify({ keys: Object.keys(response.response ?? {}), models: response.response?.models }, null, 2));
    finish();
  }
  if (agent === "codex" && event.id === 2) {
    console.log(JSON.stringify(event, null, 2));
    finish();
  }
});

if (agent === "claude") {
  write({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
} else {
  write({ id: 1, method: "initialize", params: { clientInfo: { name: "spike", version: "0" } } });
  write({ method: "initialized" });
  write({ id: 2, method: "model/list", params: {} });
}
