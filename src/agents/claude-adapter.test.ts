import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./agent-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { createFakeSpawner, flush } from "./fake-agent-process.js";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

const setup = async (options: { resumeSessionId?: string; mcpUrl?: string } = {}) => {
  const spawner = createFakeSpawner();
  const adapter = new ClaudeAdapter(spawner.spawn, () => SESSION_ID);
  const events: AgentEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  await adapter.start({ cwd: "C:\\dev\\app", ...options });
  return { adapter, spawner, proc: spawner.last, events };
};

const init = (apiKeySource = "none") => ({ type: "system", subtype: "init", session_id: SESSION_ID, apiKeySource });
const result = (text: string, subtype = "success") => ({
  type: "result", subtype, is_error: subtype !== "success", result: text, session_id: SESSION_ID,
});

describe("ClaudeAdapter", () => {
  it("stream-json の常駐プロセスを、API key を除いた環境と新しい session ID で起動する", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    const { adapter, spawner, events } = await setup();
    delete process.env.ANTHROPIC_API_KEY;

    const call = spawner.calls[0]!;
    expect(call.command).toBe("claude");
    expect(call.args).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]));
    expect(call.args).toEqual(expect.arrayContaining(["--session-id", SESSION_ID]));
    expect(call.options.cwd).toBe("C:\\dev\\app");
    expect(call.options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.options.env.CLODEX_AGENT).toBe("claude");
    expect(adapter.status).toBe("idle");
    expect(adapter.sessionId).toBe(SESSION_ID);
    expect(events).toContainEqual({ type: "session", sessionId: SESSION_ID });
  });

  it("既定は edit（acceptEdits）で起動し、後から full にできるよう skip permissions を許可しておく", async () => {
    const { spawner, adapter } = await setup();
    const args = spawner.calls[0]!.args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).toContain("--allow-dangerously-skip-permissions");
    expect(adapter.permission).toBe("edit");
  });

  it("起動前に setPermission したレベルで起動する", async () => {
    const spawner = createFakeSpawner();
    const adapter = new ClaudeAdapter(spawner.spawn, () => SESSION_ID);
    await adapter.setPermission("full");
    await adapter.start({ cwd: "C:\\dev\\app" });
    const args = spawner.calls[0]!.args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  it("起動中の setPermission は set_permission_mode を即時に送る", async () => {
    const { adapter, proc } = await setup();
    await adapter.setPermission("read-only");
    expect(proc.writtenWith("type", "control_request")[0]).toMatchObject({
      request: { subtype: "set_permission_mode", mode: "plan" },
    });
    expect(adapter.permission).toBe("read-only");
  });

  it("起動中に変更された権限は起動完了時に反映する", async () => {
    const spawner = createFakeSpawner();
    const adapter = new ClaudeAdapter(spawner.spawn, () => SESSION_ID);
    const started = adapter.start({ cwd: "C:\\dev\\app" });
    expect(adapter.status).toBe("starting");
    await adapter.setPermission("full");
    await started;
    expect(spawner.last.writtenWith("type", "control_request")[0]).toMatchObject({
      request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
    });
  });

  it("instructions 指定時は --append-system-prompt で渡す", async () => {
    const spawner = createFakeSpawner();
    const adapter = new ClaudeAdapter(spawner.spawn, () => SESSION_ID);
    await adapter.start({ cwd: "C:\\dev\\app", instructions: "You are claude." });
    const args = spawner.calls[0]!.args;
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("You are claude.");
  });

  it("resumeSessionId 指定時は -r で既存 session を継続する", async () => {
    const { spawner, adapter } = await setup({ resumeSessionId: "existing-id" });
    expect(spawner.calls[0]!.args).toEqual(expect.arrayContaining(["-r", "existing-id"]));
    expect(spawner.calls[0]!.args).not.toContain("--session-id");
    expect(adapter.sessionId).toBe("existing-id");
  });

  it("mcpUrl 指定時は Coordinator の MCP server と send_message tool を許可する", async () => {
    const { spawner } = await setup({ mcpUrl: "http://127.0.0.1:5000/mcp/claude" });
    const args = spawner.calls[0]!.args;
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
    expect(config).toEqual({ mcpServers: { clodex: { type: "http", url: "http://127.0.0.1:5000/mcp/claude" } } });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__clodex__send_message");
  });

  it("send は user メッセージを書き込み、result でターン完了として resolve する", async () => {
    const { adapter, proc, events } = await setup();
    const turn = adapter.send("hello");
    expect(adapter.status).toBe("busy");
    expect(proc.written).toContainEqual({ type: "user", message: { role: "user", content: "hello" } });

    proc.emit(init());
    proc.emit({ type: "assistant", message: { content: [
      { type: "thinking", thinking: "..." },
      { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
      { type: "text", text: "PONG" },
    ] } });
    proc.emit(result("PONG"));

    await expect(turn).resolves.toEqual({ status: "completed", text: "PONG" });
    expect(adapter.status).toBe("idle");
    expect(events).toContainEqual({ type: "tool", name: "Read", input: '{"file_path":"a.ts"}' });
    expect(events).toContainEqual({ type: "text", text: "PONG" });
    expect(events).toContainEqual({ type: "turn", result: { status: "completed", text: "PONG" } });
    expect(events.findIndex((e) => e.type === "turn_started")).toBeLessThan(events.findIndex((e) => e.type === "turn"));
  });

  it("compact は /compact を 1 ターンとして送り、compact_boundary で compacted を流す", async () => {
    const { adapter, proc, events } = await setup();
    const turn = adapter.compact();
    expect(adapter.status).toBe("busy");
    expect(proc.written).toContainEqual({ type: "user", message: { role: "user", content: "/compact" } });
    proc.emit({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 30000, post_tokens: 3000 } });
    proc.emit(result(""));
    await expect(turn).resolves.toEqual({ status: "completed", text: "" });
    expect(events).toContainEqual({ type: "compacted" });
    expect(events.filter((e) => e.type === "turn_started")).toHaveLength(1);
  });

  it("busy 中の compact は拒否する", async () => {
    const { adapter } = await setup();
    void adapter.send("x");
    await expect(adapter.compact()).rejects.toThrow(/busy/);
  });

  it("busy 中の send は拒否する", async () => {
    const { adapter } = await setup();
    void adapter.send("first");
    await expect(adapter.send("second")).rejects.toThrow(/busy/);
  });

  it("入力なしの system/init から自発ターンを開始し、result を turn として流す", async () => {
    const { adapter, proc, events } = await setup();
    proc.emit(init());
    expect(adapter.status).toBe("busy");
    proc.emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "続き" }] } });
    proc.emit(result("最終応答"));
    expect(adapter.status).toBe("idle");
    expect(events.filter((e) => e.type === "turn_started")).toHaveLength(1);
    expect(events).toContainEqual({ type: "turn", result: { status: "completed", text: "最終応答" } });
  });

  it("subagent の assistant は本体の text / tool と自発ターン開始に使わない", async () => {
    const { adapter, proc, events } = await setup();
    proc.emit({ type: "assistant", parent_tool_use_id: "toolu_agent", message: { content: [
      { type: "text", text: "内部応答" }, { type: "tool_use", name: "Read", input: { file_path: "secret" } },
    ] } });
    expect(adapter.status).toBe("idle");
    expect(events.some((e) => e.type === "turn_started" || e.type === "text" || e.type === "tool")).toBe(false);
  });

  it("自発ターン中の send と compact は完了後に送る", async () => {
    const { adapter, proc, events } = await setup();
    proc.emit(init());
    const send = adapter.send("次の入力");
    expect(proc.writtenWith("type", "user")).toHaveLength(0);
    proc.emit(result("自発応答"));
    await flush();
    expect(proc.writtenWith("type", "user")[0]).toMatchObject({ message: { content: "次の入力" } });
    proc.emit(result("入力への応答"));
    await expect(send).resolves.toEqual({ status: "completed", text: "入力への応答" });
    expect(events.filter((e) => e.type === "turn")).toHaveLength(2);

    proc.emit(init());
    const compact = adapter.compact();
    expect(proc.writtenWith("type", "user")).toHaveLength(1);
    proc.emit(result("自発応答 2"));
    await flush();
    expect(proc.writtenWith("type", "user")[1]).toMatchObject({ message: { content: "/compact" } });
    proc.emit(result(""));
    await expect(compact).resolves.toEqual({ status: "completed", text: "" });
  });

  it("interrupt は control_request を送り、そのターンを interrupted で終える", async () => {
    const { adapter, proc } = await setup();
    const turn = adapter.send("long task");
    proc.emit(init());
    await adapter.interrupt();

    const request = proc.writtenWith("type", "control_request")[0];
    expect(request).toMatchObject({ request: { subtype: "interrupt" } });
    proc.emit({ type: "control_response", response: { subtype: "success", request_id: request!.request_id } });
    proc.emit(result("", "error_during_execution"));

    await expect(turn).resolves.toEqual({ status: "interrupted", text: "" });
  });

  it("interrupt していないエラー終了は failed になる", async () => {
    const { adapter, proc } = await setup();
    const turn = adapter.send("x");
    proc.emit(result("boom", "error_during_execution"));
    await expect(turn).resolves.toEqual({ status: "failed", text: "boom" });
  });

  it("サブスクリプション以外の認証（apiKeySource が none 以外）ならプロセスを止めてターンを失敗させる", async () => {
    const { adapter, proc, events } = await setup();
    const turn = adapter.send("x");
    proc.emit(init("ANTHROPIC_API_KEY"));

    await expect(turn).resolves.toMatchObject({ status: "failed" });
    expect(proc.killed).toBe(true);
    expect(adapter.status).toBe("stopped");
    expect(events.some((e) => e.type === "error" && /ANTHROPIC_API_KEY/.test(e.message))).toBe(true);
  });

  it("401 の api_retry は retry を待たずに失敗させる", async () => {
    const { adapter, proc } = await setup();
    const turn = adapter.send("x");
    proc.emit({ type: "system", subtype: "api_retry", attempt: 1, error_status: 401, error: "authentication_failed" });
    await expect(turn).resolves.toMatchObject({ status: "failed" });
    expect(proc.killed).toBe(true);
  });

  it("ターン完了時に、最後の API 呼び出しの usage からコンテキストの大きさを流す", async () => {
    const { adapter, proc, events } = await setup();
    const turn = adapter.send("x");
    proc.emit(init());
    const usage = (input: number) => ({ input_tokens: input, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 50 });
    proc.emit({ type: "assistant", message: { content: [{ type: "text", text: "a" }], usage: usage(10) } });
    proc.emit({ type: "assistant", message: { content: [{ type: "text", text: "b" }], usage: usage(500) } });
    proc.emit({ ...result("b"), modelUsage: { "claude-x": { contextWindow: 200000 } } });
    await turn;
    expect(events).toContainEqual({ type: "context", tokens: 21550, window: 200000 });
  });

  it("rate_limit_event を % に正規化して流す", async () => {
    const { proc, events } = await setup();
    proc.emit({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 0.02, resetsAt: 1791198600 },
      seven_day: { utilization: 0.49, resetsAt: 1791522000 },
    } } });
    expect(events).toContainEqual({
      type: "rate_limit",
      fiveHour: { usedPercent: 2, resetsAt: 1791198600 },
      weekly: { usedPercent: 49, resetsAt: 1791522000 },
    });
  });

  it("プロセスが落ちたら実行中のターンを failed にし、stopped になる", async () => {
    const { adapter, proc, events } = await setup();
    const turn = adapter.send("x");
    proc.exit(1);
    await expect(turn).resolves.toMatchObject({ status: "failed" });
    expect(adapter.status).toBe("stopped");
    expect(events).toContainEqual({ type: "exit", code: 1 });
  });

  it("stop はプロセスを止め、session ID は resume 用に保持する", async () => {
    const { adapter, proc } = await setup();
    await adapter.stop();
    await flush();
    expect(proc.killed).toBe(true);
    expect(adapter.status).toBe("stopped");
    expect(adapter.sessionId).toBe(SESSION_ID);
  });

  it("起動に失敗したら start を reject し、stopped のままにする", async () => {
    const spawner = createFakeSpawner(undefined, { spawnError: new Error("spawn claude ENOENT") });
    const adapter = new ClaudeAdapter(spawner.spawn, () => SESSION_ID);
    const events: AgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await expect(adapter.start({ cwd: "C:\dev\app" })).rejects.toThrow("ENOENT");
    await flush();
    expect(adapter.status).toBe("stopped");
    expect(events.some((e) => e.type === "session")).toBe(false);
  });

  it("同時に呼ばれた stop はすべて終了を待って resolve する", async () => {
    const spawner = createFakeSpawner(undefined, { exitOnKill: false });
    const adapter = new ClaudeAdapter(spawner.spawn, () => SESSION_ID);
    await adapter.start({ cwd: "C:\dev\app" });
    let resolved = 0;
    const stops = [adapter.stop(), adapter.stop()].map((p) => p.then(() => resolved++));
    await flush();
    expect(resolved).toBe(0);
    spawner.last.exit(0);
    await Promise.all(stops);
    expect(resolved).toBe(2);
  });

  it("壊れた行は error イベントにして処理を続ける", async () => {
    const { adapter, proc, events } = await setup();
    const turn = adapter.send("x");
    proc.emitRaw("not json");
    proc.emit(result("ok"));
    await expect(turn).resolves.toEqual({ status: "completed", text: "ok" });
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});
