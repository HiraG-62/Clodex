import { describe, expect, it, vi } from "vitest";
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
  it("入力の書き込み失敗を failed で返し、次のターンを受け付ける", async () => {
    const { adapter, proc, events } = await setup();
    vi.spyOn(proc, "write").mockImplementationOnce(() => { throw new Error("write failed"); });
    await expect(adapter.send("first")).resolves.toEqual({ status: "failed", text: "write failed" });
    expect(adapter.status).toBe("idle");
    const second = adapter.send("second");
    proc.emit(result("ok"));
    await expect(second).resolves.toEqual({ status: "completed", text: "ok" });
    expect(events).toContainEqual({ type: "turn", result: { status: "failed", text: "write failed" } });
  });

  it("quiet な設定ターンの書き込み失敗も failed にし、event を出さない", async () => {
    const { adapter, proc, events } = await setup();
    vi.spyOn(proc, "write").mockImplementationOnce(() => { throw new Error("quiet write failed"); });
    await expect(adapter.setModel("haiku")).resolves.toEqual({ status: "failed", text: "quiet write failed" });
    expect(adapter.status).toBe("idle");
    expect(events.filter((event) => event.type === "turn_started" || event.type === "turn")).toEqual([]);
  });
  it("background_tasks_changed の local_agent だけを数え、ターンの外でも一覧を更新する", async () => {
    const { adapter, proc, events } = await setup();
    const quick = { task_id: "quick", description: "調査", task_type: "local_agent" };
    const slow = { task_id: "slow", description: "実装", task_type: "local_agent" };
    const bash = { task_id: "bash", description: "sleep", task_type: "local_bash" };
    for (const tasks of [[quick], [quick, slow, bash], [slow, bash], [bash]]) {
      proc.emit({ type: "system", subtype: "background_tasks_changed", tasks });
    }
    expect(events.filter((event) => event.type === "subagents")).toEqual([
      { type: "subagents", running: [{ id: "quick", description: "調査" }] },
      { type: "subagents", running: [{ id: "quick", description: "調査" }, { id: "slow", description: "実装" }] },
      { type: "subagents", running: [{ id: "slow", description: "実装" }] },
      { type: "subagents", running: [] },
    ]);
    expect(events.some((event) => event.type === "turn_started")).toBe(false);
    expect(adapter.status).toBe("idle");
  });

  it("プロセス終了時に background Agent の一覧を空にする", async () => {
    const { proc, events } = await setup();
    proc.emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a", description: "調査", task_type: "local_agent" }] });
    proc.exit(0);
    expect(events.filter((event) => event.type === "subagents").at(-1)).toEqual({ type: "subagents", running: [] });
  });

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

  it("停止中の model / effort は起動引数に反映する", async () => {
    const spawner = createFakeSpawner();
    const adapter = new ClaudeAdapter(spawner.spawn, () => SESSION_ID);
    await adapter.setModel("haiku");
    await adapter.setEffort("high");
    await adapter.start({ cwd: "C:\\dev\\app" });
    expect(spawner.calls[0]!.args).toEqual(expect.arrayContaining(["--model", "haiku", "--effort", "high"]));
  });

  it("idle の model / effort 変更は slash command を各 1 ターンとして送る", async () => {
    const { adapter, spawner, proc, events } = await setup();
    const model = adapter.setModel("haiku");
    expect(proc.writtenWith("type", "user")).toContainEqual({ type: "user", message: { role: "user", content: "/model haiku" } });
    proc.emit(result("Set model to `Haiku 4.5` for this session only"));
    await expect(model).resolves.toMatchObject({ status: "completed" });
    const effort = adapter.setEffort("medium");
    expect(proc.writtenWith("type", "user")).toContainEqual({ type: "user", message: { role: "user", content: "/effort medium" } });
    proc.emit(result("Set effort level to medium (this session only)"));
    await expect(effort).resolves.toMatchObject({ status: "completed" });
    expect(spawner.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_started" || event.type === "turn")).toEqual([]);
    const turn = adapter.send("hello");
    proc.emit(result("done"));
    await expect(turn).resolves.toEqual({ status: "completed", text: "done" });
    expect(events.filter((event) => event.type === "turn_started" || event.type === "turn")).toEqual([
      { type: "turn_started" },
      { type: "turn", result: { status: "completed", text: "done" } },
    ]);
  });

  it("不正な model / effort は is_error=false でも failed にする", async () => {
    const { adapter, proc, events } = await setup();
    const model = adapter.setModel("missing-model");
    proc.emit(result("Model 'missing-model' not found"));
    await expect(model).resolves.toEqual({ status: "failed", text: "Model 'missing-model' not found" });
    const effort = adapter.setEffort("bogus");
    proc.emit(result("Invalid argument: bogus. Valid options are: low, medium, high, xhigh, max, auto"));
    await expect(effort).resolves.toMatchObject({ status: "failed" });
    expect(adapter.model).toBeUndefined();
    expect(adapter.effort).toBeUndefined();
    expect(events.filter((event) => event.type === "turn_started" || event.type === "turn")).toEqual([]);
  });

  it("一時的な API error は failed のターンにし、プロセスは続ける", async () => {
    const { adapter, proc } = await setup();
    const first = adapter.send("first");
    proc.emit({ ...result("API overloaded"), is_error: true, terminal_reason: "api_error" });
    await expect(first).resolves.toEqual({ status: "failed", text: "API overloaded" });
    expect(adapter.status).toBe("idle");
    const second = adapter.send("second");
    proc.emit(result("ok"));
    await expect(second).resolves.toEqual({ status: "completed", text: "ok" });
  });

  it("busy 中の直接の設定は拒否し、mailbox 側の直列化に任せる", async () => {
    const { adapter, proc } = await setup();
    const first = adapter.send("first");
    await expect(adapter.setModel("haiku")).rejects.toThrow(/busy/);
    await expect(adapter.setEffort("high")).rejects.toThrow(/busy/);
    proc.emit(result("done"));
    await first;
  });

  it("起動処理中の model / effort 変更は起動後に各 1 ターンとして送る", async () => {
    const spawner = createFakeSpawner();
    const adapter = new ClaudeAdapter(spawner.spawn, () => SESSION_ID);
    const started = adapter.start({ cwd: "C:\\dev\\app" });
    const model = adapter.setModel("haiku");
    await started;
    expect(spawner.calls).toHaveLength(1);
    await flush();
    expect(spawner.last.writtenWith("type", "user")).toContainEqual({ type: "user", message: { role: "user", content: "/model haiku" } });
    spawner.last.emit(result("Set model to `Haiku 4.5` for this session only"));
    await model;
    const effort = adapter.setEffort("high");
    expect(spawner.last.writtenWith("type", "user")).toContainEqual({ type: "user", message: { role: "user", content: "/effort high" } });
    spawner.last.emit(result("Set effort level to high (this session only)"));
    await effort;
    expect(spawner.calls).toHaveLength(1);
  });

  it("通常の user text の /model は設定ターン判定に使わない", async () => {
    const { adapter, proc } = await setup();
    const turn = adapter.send("/model invalid");
    proc.emit(result("Model 'invalid' not found"));
    await expect(turn).resolves.toEqual({ status: "completed", text: "Model 'invalid' not found" });
  });

  it("compact は直前の設定ターンが完了してから送る", async () => {
    const { adapter, proc } = await setup();
    const setting = adapter.setEffort("low");
    await expect(adapter.compact()).rejects.toThrow(/busy/);
    proc.emit(result("Set effort level to low (this session only)"));
    await setting;
    const compacted = adapter.compact();
    expect(proc.writtenWith("type", "user")).toContainEqual({ type: "user", message: { role: "user", content: "/compact" } });
    proc.emit(result(""));
    await expect(compacted).resolves.toEqual({ status: "completed", text: "" });
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
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__clodex__send_message,mcp__clodex__ask_user,mcp__clodex__read_conversation");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("AskUserQuestion");
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

  it("abort 後は exit まで busy を保ち、次の send を終了中プロセスへ書かない", async () => {
    const spawner = createFakeSpawner(undefined, { exitOnKill: false });
    const adapter = new ClaudeAdapter(spawner.spawn, () => SESSION_ID);
    await adapter.start({ cwd: "C:\\dev\\app" });
    const turn = adapter.send("first");
    spawner.last.emit(init("ANTHROPIC_API_KEY"));
    expect(adapter.status).toBe("busy");
    spawner.last.emit(result("終了中の遅延応答"));
    expect(adapter.status).toBe("busy");
    await expect(adapter.send("second")).rejects.toThrow(/busy/);
    expect(spawner.last.writtenWith("type", "user")).toHaveLength(1);
    spawner.last.exit(null);
    await expect(turn).resolves.toEqual({ status: "failed", text: "claude is not using subscription auth (apiKeySource: ANTHROPIC_API_KEY)" });
    expect(adapter.status).toBe("stopped");
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

describe("ClaudeAdapter の変更ファイル", () => {
  it("編集系の tool は変更したファイルを files に入れ、読むだけの tool には入れない", async () => {
    const { adapter, proc, events } = await setup();
    void adapter.send("edit");
    proc.emit(init());
    proc.emit({ type: "assistant", message: { content: [
      { type: "tool_use", name: "Edit", input: { file_path: "C:\\dev\\app\\a.ts", old_string: "x", new_string: "y" } },
      { type: "tool_use", name: "NotebookEdit", input: { notebook_path: "n.ipynb" } },
      { type: "tool_use", name: "Read", input: { file_path: "b.ts" } },
    ] } });
    const tools = events.filter((e) => e.type === "tool");
    expect(tools.map((e) => e.type === "tool" && e.files)).toEqual([["C:\\dev\\app\\a.ts"], ["n.ipynb"], undefined]);
  });
});

describe("ClaudeAdapter の steer", () => {
  it("実行中のターンには user message を足し、実行中でなければ false", async () => {
    const { adapter, proc } = await setup();
    await expect(adapter.steer("今のうちに", "s-0")).resolves.toBe(false);
    void adapter.send("work");
    await expect(adapter.steer("方針を変えて", "s-1")).resolves.toBe(true);
    expect(proc.written).toContainEqual({ type: "user", uuid: expect.any(String), message: { role: "user", content: "方針を変えて" } });
    expect(adapter.status).toBe("busy");
  });

  it("割り込みの行の replay を受け取ったら steer_delivered を出す", async () => {
    const { adapter, proc, events, spawner } = await setup();
    expect(spawner.calls[0]!.args).toContain("--replay-user-messages");
    void adapter.send("work");
    await adapter.steer("方針を変えて", "s-1");
    const line = proc.written.find((w) => (w as { message?: { content?: unknown } }).message?.content === "方針を変えて") as { uuid: string };
    proc.emit({ type: "user", isReplay: true, uuid: "other", message: { role: "user", content: "work" } });
    expect(events.filter((e) => e.type === "steer_delivered")).toEqual([]);
    proc.emit({ type: "user", isReplay: true, uuid: line.uuid, message: { role: "user", content: "方針を変えて" } });
    expect(events.filter((e) => e.type === "steer_delivered")).toEqual([{ type: "steer_delivered", steerId: "s-1" }]);
    proc.emit({ type: "user", isReplay: true, uuid: line.uuid, message: { role: "user", content: "方針を変えて" } });
    expect(events.filter((e) => e.type === "steer_delivered")).toHaveLength(1);
  });
});

describe("ClaudeAdapter の画像", () => {
  it("画像は base64 の image block として本文の前に並べる", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "clodex-img-")), "a.png");
    writeFileSync(path, Buffer.from([1, 2, 3]));
    const { adapter, proc } = await setup();
    void adapter.send("見て", [path]);
    expect(proc.written).toContainEqual({ type: "user", message: { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "text", text: "見て" },
    ] } });
  });
});
