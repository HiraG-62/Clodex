// model の一覧と利用枠を、ターンを送らずに取得できるかを実測する
// Claude: control_request の initialize（models）と get_usage（rate_limits）。Codex: model/list と account/rateLimits/read
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
const expected = new Set(agent === "claude" ? ["init", "usage"] : [2, 3]);
const done = (key: string | number) => {
  expected.delete(key);
  if (expected.size) return;
  clearTimeout(timer);
  child.kill();
};

createInterface({ input: child.stdout }).on("line", (line) => {
  const event = JSON.parse(line) as Record<string, unknown>;
  if (agent === "claude" && event.type === "control_response") {
    const response = (event.response ?? {}) as { request_id?: string; response?: Record<string, unknown> };
    if (response.request_id === "init") console.log(JSON.stringify({ keys: Object.keys(response.response ?? {}), models: response.response?.models }, null, 2));
    if (response.request_id === "usage") console.log(JSON.stringify(response.response?.rate_limits, null, 2));
    if (response.request_id) done(response.request_id);
  }
  if (agent === "codex" && typeof event.id === "number" && expected.has(event.id)) {
    console.log(JSON.stringify(event, null, 2));
    done(event.id);
  }
});

if (agent === "claude") {
  write({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
  write({ type: "control_request", request_id: "usage", request: { subtype: "get_usage" } });
} else {
  write({ id: 1, method: "initialize", params: { clientInfo: { name: "spike", version: "0" } } });
  write({ method: "initialized" });
  write({ id: 2, method: "model/list", params: {} });
  write({ id: 3, method: "account/rateLimits/read" });
}
