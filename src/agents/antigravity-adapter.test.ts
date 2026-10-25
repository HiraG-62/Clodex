import { describe, expect, it } from "vitest";
import { AntigravityAdapter } from "./antigravity-adapter.js";
import { createFakeSpawner, flush } from "./fake-agent-process.js";

describe("AntigravityAdapter", () => {
  it("session・text・tool・turn・usage を stream-json から変換する", async () => {
    const fake = createFakeSpawner();
    const adapter = new AntigravityAdapter(fake.spawn);
    const events: unknown[] = [];
    adapter.onEvent(event => events.push(event));
    await adapter.start({ cwd: "C:\\project", mcpUrl: "http://localhost/mcp" });
    expect(fake.calls[0]?.args).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--mode", "accept-edits"]);
    expect(fake.calls[0]?.options.env.CLODEX_MCP_URL).toBe("http://localhost/mcp");
    fake.last.emit({ event: "init", conversation_id: "conversation-1", init: { model: "flash" } });
    const turn = adapter.send("調べる", ["C:\\image.png"]);
    expect(fake.last.written.at(-1)).toEqual({ event: "user", message: { content: "調べる\n\n[image] C:\\image.png" } });
    fake.last.emit({ event: "step_update", step_update: { step_type: "agent_response", step_index: 1, state: "ACTIVE", text_delta: "結" } });
    fake.last.emit({ event: "step_update", step_update: { step_type: "agent_response", step_index: 1, state: "DONE", text_delta: "果" } });
    fake.last.emit({
      event: "step_update",
      step_update: { step_type: "tool", state: "ACTIVE", tool_info: { name: "run_command", parameters: { CommandLine: "pnpm test" } } },
    });
    fake.last.emit({
      event: "step_update",
      step_update: { step_type: "tool", state: "ACTIVE", tool_info: { name: "write_to_file", parameters: { TargetFile: "src/a.ts" } } },
    });
    fake.last.emit({ event: "result", result: { status: "SUCCESS", response: "結果", usage: { input_tokens: 10, cache_read_tokens: 2, output_tokens: 3 } } });
    expect(await turn).toEqual({ status: "completed", text: "結果" });
    expect(events).toContainEqual({ type: "session", sessionId: "conversation-1" });
    expect(events).toContainEqual({ type: "text", text: "結果" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", name: "command", command: "pnpm test" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", name: "write_to_file", files: ["src/a.ts"] }));
    expect(events).toContainEqual({ type: "usage", input: 8, cachedInput: 2, output: 3 });
    expect(events).toContainEqual({ type: "input_total", total: 10 });
  });

  it("denied_actions を error として画面に出す", async () => {
    const fake = createFakeSpawner();
    const adapter = new AntigravityAdapter(fake.spawn);
    const events: unknown[] = [];
    adapter.onEvent(event => events.push(event));
    await adapter.start({ cwd: "C:\\project" });
    fake.last.emit({ event: "init", conversation_id: "conversation-1" });
    const turn = adapter.send("作業");
    fake.last.emit({
      event: "result",
      result: { status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }, { action: "mcp" }] },
    });
    expect(await turn).toEqual({ status: "completed", text: "" });
    expect(events).toContainEqual({ type: "error", message: "gemini: tools denied by permission mode: RunCommand, mcp" });
  });

  it("中断後は conversation を指定して再開する", async () => {
    const fake = createFakeSpawner();
    const adapter = new AntigravityAdapter(fake.spawn);
    await adapter.start({ cwd: "C:\\project" });
    fake.last.emit({ event: "init", conversation_id: "conversation-1" });
    const turn = adapter.send("長い作業");
    await adapter.interrupt();
    expect(await turn).toEqual({ status: "interrupted", text: "" });
    const resumed = adapter.send("続き");
    expect(fake.calls[1]?.args).toContain("--conversation");
    expect(fake.calls[1]?.args).toContain("conversation-1");
    await flush();
    fake.last.emit({ event: "result", result: { status: "SUCCESS", response: "完了" } });
    expect(await resumed).toEqual({ status: "completed", text: "完了" });
  });

  it("permission・model の変更でプロセスを入れ替え、effort は起動引数に含めない", async () => {
    const fake = createFakeSpawner();
    const adapter = new AntigravityAdapter(fake.spawn);
    await adapter.setEffort("high");
    await adapter.start({ cwd: "C:\\project" });
    expect(fake.calls[0]?.args).not.toContain("--effort");
    fake.last.emit({ event: "init", conversation_id: "conversation-1" });
    await adapter.setPermission("read-only");
    expect(fake.calls[1]?.args).toContain("plan");
    await adapter.setModel("flash");
    expect(fake.calls[2]?.args).toContain("flash");
    expect(fake.calls[2]?.args).not.toContain("--effort");
    expect(await adapter.steer()).toBe(false);
  });
});
