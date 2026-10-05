// stream-json / app-server の model・effort 切り替えを実測する
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const agent = process.argv[2];
const resumeId = process.argv[3];
const invalidModel = resumeId === "--invalid-model";
const slashCommands = resumeId === "--slash";
const EVENT_POLL_MS = 100;
const EVENT_POLL_LIMIT = 300;
if (agent !== "claude" && agent !== "codex") throw new Error("usage: tsx spikes/model-effort.ts <claude|codex>");
const child = spawn(agent, agent === "claude"
  ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    ...(!slashCommands ? ["--model", "haiku"] : []), "--effort", "low"]
  : ["app-server"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (chunk) => console.error(String(chunk).slice(0, 300)));
const lines = createInterface({ input: child.stdout });
const events: Record<string, unknown>[] = [];
const pending = new Map<number, (value: Record<string, unknown>) => void>();
let nextId = 1;
lines.on("line", (line) => {
  const event = JSON.parse(line) as Record<string, unknown>;
  events.push(event);
  if (agent === "claude") {
    if (event.type === "system" && event.subtype === "init") console.log("init", JSON.stringify({ model: event.model, effort: event.effort, per_turn_effort_active: event.per_turn_effort_active }));
    if (event.type === "control_response") console.log("control_response", JSON.stringify(event));
    if (event.type === "result") {
      const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      console.log("result", JSON.stringify({ result: String(event.result ?? "").slice(0, 300), subtype: event.subtype,
        is_error: event.is_error, total_cost_usd: event.total_cost_usd, usage: usage && { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } }));
    }
  } else {
    if (event.id !== undefined) pending.get(Number(event.id))?.(event);
    if (event.method === "turn/completed") console.log("turn/completed", JSON.stringify(event.params));
  }
});
const write = (event: unknown) => child.stdin.write(`${JSON.stringify(event)}\n`);
const waitFor = async (predicate: (event: Record<string, unknown>) => boolean) => {
  for (let attempt = 0; attempt < EVENT_POLL_LIMIT; attempt++) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, EVENT_POLL_MS));
  }
  throw new Error("event timeout");
};
const request = async (method: string, params: unknown) => {
  const id = nextId++;
  const response = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
  write({ id, method, params });
  const value = await response;
  pending.delete(id);
  const result = value.result as { model?: string; reasoningEffort?: string | null; thread?: { id: string; model?: string; reasoningEffort?: string | null } } | undefined;
  console.log(method, JSON.stringify({ error: value.error, model: result?.model, reasoningEffort: result?.reasoningEffort,
    thread: result?.thread && { id: result.thread.id, model: result.thread.model, reasoningEffort: result.thread.reasoningEffort } }));
  return value;
};

try {
  if (agent === "claude") {
    const user = (content: string) => write({ type: "user", message: { role: "user", content } });
    if (slashCommands) {
      const prompts = ["/model haiku", "/effort high", "Reply with exactly PING.", "/model no-such-model", "/effort bogus", "Reply with exactly DONE."];
      for (const prompt of prompts) {
        const before = events.filter((event) => event.type === "result").length;
        console.log("send", prompt);
        user(prompt);
        await waitFor(() => events.filter((event) => event.type === "result").length > before);
      }
      child.stdin.end();
      child.kill();
      process.exit(0);
    }
    user("Reply with exactly ONE.");
    await waitFor((event) => event.type === "result");
    write({ type: "control_request", request_id: "model-1", request: { subtype: "set_model", model: invalidModel ? "nonexistent-clodex-model" : "haiku" } });
    write({ type: "control_request", request_id: "effort-1", request: { subtype: "set_effort", effort: "medium" } });
    await waitFor((event) => event.type === "control_response" && (event.response as { request_id?: string } | undefined)?.request_id === "effort-1");
    user("Reply with exactly TWO.");
    await waitFor(() => events.filter((event) => event.type === "result").length >= 2);
  } else {
    await request("initialize", { clientInfo: { name: "clodex-spike", title: "Clodex Spike", version: "0.0.0" }, capabilities: null });
    write({ method: "initialized" });
    if (resumeId) {
      await request("thread/resume", { threadId: resumeId, cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only" });
      child.stdin.end();
      child.kill();
      process.exit(0);
    }
    const started = await request("thread/start", { cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only" });
    const data = started.result as { thread: { id: string }; model?: string; reasoningEffort?: string | null };
    const threadId = data.thread.id;
    const input = (text: string) => [{ type: "text", text, text_elements: [] }];
    await request("turn/start", { threadId, input: input("Reply with exactly ONE."), model: data.model, effort: "low" });
    await waitFor((event) => event.method === "turn/completed");
    await request("turn/start", { threadId, input: input("Reply with exactly TWO.") });
    await waitFor(() => events.filter((event) => event.method === "turn/completed").length >= 2);
    await request("thread/read", { threadId, includeTurns: false });
    await request("thread/resume", { threadId, cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only" });
  }
} finally {
  child.stdin.end();
  child.kill();
}
