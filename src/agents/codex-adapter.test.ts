import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./agent-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { createFakeSpawner, flush, type JsonObject } from "./fake-agent-process.js";

const THREAD_ID = "thr-1";
const TURN_ID = "turn-1";

const defaultResponder = (accountType = "chatgpt") => (m: JsonObject): unknown => {
  const params = m.params as JsonObject | undefined;
  switch (m.method) {
    case "initialize": return { userAgent: "codex" };
    case "account/read": return { account: { type: accountType } };
    case "thread/start": return { thread: { id: THREAD_ID } };
    case "thread/resume": return { thread: { id: params?.threadId } };
    case "turn/start": return { turn: { id: TURN_ID, status: "inProgress" } };
    case "turn/interrupt": return {};
    case "account/rateLimits/read": return { rateLimits: { primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 100 }, secondary: null } };
    default: return undefined;
  }
};

const setup = async (options: { resumeSessionId?: string; mcpUrl?: string; accountType?: string } = {}) => {
  const spawner = createFakeSpawner(defaultResponder(options.accountType));
  const adapter = new CodexAdapter(spawner.spawn);
  const events: AgentEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  const { accountType: _, ...startOptions } = options;
  const started = adapter.start({ cwd: "C:\\dev\\app", ...startOptions });
  return { adapter, spawner, events, started, get proc() { return spawner.last; } };
};

const turnCompleted = (status: string) => ({
  method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status } },
});
const agentMessage = (text: string) => ({
  method: "item/completed", params: { threadId: THREAD_ID, item: { type: "agentMessage", id: "m1", text } },
});

describe("CodexAdapter", () => {
  it("app-server を API key を除いた環境で起動し、initialize → 認証確認 → thread/start を行う", async () => {
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    const { adapter, spawner, events, started } = await setup();
    delete process.env.OPENAI_API_KEY;
    await started;

    const call = spawner.calls[0]!;
    expect(call.command).toBe("codex");
    expect(call.args[0]).toBe("app-server");
    expect(call.options.env.OPENAI_API_KEY).toBeUndefined();
    expect(call.options.env.CLODEX_AGENT).toBe("codex");

    const methods = spawner.last.written.map((m) => m.method);
    expect(methods).toEqual(["initialize", "initialized", "account/read", "thread/start", "account/rateLimits/read"]);
    await flush();
    expect(events).toContainEqual({ type: "rate_limit", fiveHour: { usedPercent: 4, resetsAt: 100 } });
    expect(spawner.last.writtenWith("method", "thread/start")[0]!.params).toMatchObject({
      cwd: "C:\\dev\\app", approvalPolicy: "never", sandbox: "workspace-write",
    });
    expect(adapter.status).toBe("idle");
    expect(adapter.sessionId).toBe(THREAD_ID);
    expect(events).toContainEqual({ type: "session", sessionId: THREAD_ID });
  });

  it("instructions 指定時は thread/start と thread/resume の developerInstructions で渡す", async () => {
    const spawner = createFakeSpawner(defaultResponder());
    const adapter = new CodexAdapter(spawner.spawn);
    await adapter.start({ cwd: "C:\\dev\\app", instructions: "You are codex." });
    expect(spawner.last.writtenWith("method", "thread/start")[0]!.params).toMatchObject({ developerInstructions: "You are codex." });

    const resumed = new CodexAdapter(spawner.spawn);
    await resumed.start({ cwd: "C:\\dev\\app", resumeSessionId: THREAD_ID, instructions: "You are codex." });
    expect(spawner.last.writtenWith("method", "thread/resume")[0]!.params).toMatchObject({ developerInstructions: "You are codex." });
  });

  it("起動前に setPermission したレベルの sandbox で thread を始める", async () => {
    const spawner = createFakeSpawner(defaultResponder());
    const adapter = new CodexAdapter(spawner.spawn);
    await adapter.setPermission("read-only");
    await adapter.start({ cwd: "C:\\dev\\app" });
    expect(spawner.last.writtenWith("method", "thread/start")[0]!.params).toMatchObject({ sandbox: "read-only" });
    expect(adapter.permission).toBe("read-only");
  });

  it("停止中の model / effort は起動後の最初の turn/start に反映する", async () => {
    const spawner = createFakeSpawner(defaultResponder());
    const adapter = new CodexAdapter(spawner.spawn);
    await adapter.setModel("gpt-6-sol");
    await adapter.setEffort("low");
    await adapter.start({ cwd: "C:\\dev\\app" });
    expect(spawner.last.writtenWith("method", "thread/start")[0]!.params).toMatchObject({ model: "gpt-6-sol" });
    const turn = adapter.send("a");
    expect(spawner.last.writtenWith("method", "turn/start")[0]!.params).toMatchObject({ model: "gpt-6-sol", effort: "low" });
    spawner.last.emit(turnCompleted("completed"));
    await turn;
  });

  it("idle と busy 中の model / effort 変更は次の turn/start に反映する", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    await adapter.setModel("gpt-6-sol");
    await adapter.setEffort("high");
    const first = adapter.send("a");
    expect(proc.writtenWith("method", "turn/start")[0]!.params).toMatchObject({ model: "gpt-6-sol", effort: "high" });
    await adapter.setEffort("low");
    await adapter.setModel("gpt-5.6-luna");
    proc.emit(turnCompleted("completed"));
    await first;
    const second = adapter.send("b");
    expect(proc.writtenWith("method", "turn/start")[1]!.params).toMatchObject({ model: "gpt-5.6-luna", effort: "low" });
    proc.emit(turnCompleted("completed"));
    await second;
  });

  it("起動処理中の model / effort 変更は最初の turn/start に反映する", async () => {
    const responder = defaultResponder();
    const spawner = createFakeSpawner((message) => message.method === "thread/start" ? undefined : responder(message));
    const adapter = new CodexAdapter(spawner.spawn);
    const started = adapter.start({ cwd: "C:\\dev\\app" });
    await flush();
    await adapter.setModel("gpt-5.6-luna");
    await adapter.setEffort("high");
    const request = spawner.last.writtenWith("method", "thread/start")[0]!;
    spawner.last.emit({ id: request.id, result: { thread: { id: THREAD_ID }, model: "gpt-6-sol", reasoningEffort: "medium" } });
    await started;
    const turn = adapter.send("a");
    expect(spawner.last.writtenWith("method", "turn/start")[0]!.params).toMatchObject({ model: "gpt-5.6-luna", effort: "high" });
    spawner.last.emit(turnCompleted("completed"));
    await turn;
  });

  it("thread/start を送った後の起動中に変更された権限は、最初の turn/start で反映する", async () => {
    const responder = defaultResponder();
    const spawner = createFakeSpawner((m) => (m.method === "thread/start" ? undefined : responder(m)));
    const adapter = new CodexAdapter(spawner.spawn);
    const started = adapter.start({ cwd: "C:\\dev\\app" });
    await flush();
    const threadStart = spawner.last.writtenWith("method", "thread/start")[0]!;
    expect(threadStart.params).toMatchObject({ sandbox: "workspace-write" });
    await adapter.setPermission("read-only");
    spawner.last.emit({ id: threadStart.id, result: { thread: { id: THREAD_ID } } });
    await started;

    void adapter.send("a");
    await flush();
    expect(spawner.last.writtenWith("method", "turn/start")[0]!.params).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
  });

  it("起動中の setPermission は次の turn/start に sandboxPolicy を 1 回だけ付ける", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    await adapter.setPermission("full");
    const first = adapter.send("a");
    await flush();
    expect(proc.writtenWith("method", "turn/start")[0]!.params).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" } });
    proc.emit(turnCompleted("completed"));
    await first;

    void adapter.send("b");
    await flush();
    expect(proc.writtenWith("method", "turn/start")[1]!.params).not.toHaveProperty("sandboxPolicy");
  });

  it("ChatGPT 認証でなければ起動を拒否してプロセスを止める", async () => {
    const { adapter, started, proc, events } = await setup({ accountType: "apiKey" });
    await expect(started).rejects.toThrow(/apiKey/);
    expect(proc.killed).toBe(true);
    expect(adapter.status).toBe("stopped");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("resumeSessionId 指定時は thread/resume を使う", async () => {
    const { adapter, started, proc } = await setup({ resumeSessionId: "old-thread" });
    await started;
    expect(proc.writtenWith("method", "thread/resume")[0]!.params).toMatchObject({ threadId: "old-thread" });
    expect(proc.writtenWith("method", "thread/start")).toHaveLength(0);
    expect(adapter.sessionId).toBe("old-thread");
  });

  it("mcpUrl 指定時は MCP server の URL と tool の自動承認を設定する", async () => {
    const { spawner, started } = await setup({ mcpUrl: "http://127.0.0.1:5000/mcp/codex" });
    await started;
    const args = spawner.calls[0]!.args;
    expect(args).toEqual(expect.arrayContaining([
      "-c", 'mcp_servers.clodex.url="http://127.0.0.1:5000/mcp/codex"',
      "-c", 'mcp_servers.clodex.default_tools_approval_mode="approve"',
    ]));
  });

  it("send は turn/start を送り、turn/completed で最後の agentMessage を結果にする", async () => {
    const { adapter, started, proc, events } = await setup();
    await started;
    const turn = adapter.send("hello");
    expect(adapter.status).toBe("busy");
    await flush();
    expect(proc.writtenWith("method", "turn/start")[0]!.params).toEqual({
      threadId: THREAD_ID, input: [{ type: "text", text: "hello", text_elements: [] }],
    });

    proc.emit({ method: "item/completed", params: { item: { type: "mcpToolCall", server: "clodex", tool: "send_message", arguments: { to: "claude" } } } });
    proc.emit({ method: "item/completed", params: { item: { type: "commandExecution", command: "git diff" } } });
    proc.emit(agentMessage("first"));
    proc.emit(agentMessage("PONG"));
    proc.emit(turnCompleted("completed"));

    await expect(turn).resolves.toEqual({ status: "completed", text: "PONG" });
    expect(adapter.status).toBe("idle");
    expect(events).toContainEqual({ type: "tool", name: "clodex.send_message", input: '{"to":"claude"}' });
    expect(events).toContainEqual({ type: "tool", name: "command", input: "git diff" });
    expect(events).toContainEqual({ type: "text", text: "PONG" });
  });

  it("fileChange item の変更ファイルを tool event にする", async () => {
    const { started, proc, events } = await setup();
    await started;
    proc.emit({ method: "item/completed", params: { item: { type: "fileChange", changes: [
      { path: "src/a.ts", kind: { type: "update" }, diff: "..." },
      { path: "src/b.ts", kind: { type: "add" }, diff: "..." },
    ] } } });
    expect(events).toContainEqual({ type: "tool", name: "fileChange", input: "src/a.ts, src/b.ts", files: ["src/a.ts", "src/b.ts"] });
  });

  it("turn/start の error 応答はターンを failed にする", async () => {
    const responder = defaultResponder();
    const spawner = createFakeSpawner((m) => (m.method === "turn/start" ? undefined : responder(m)));
    const adapter = new CodexAdapter(spawner.spawn);
    await adapter.start({ cwd: "C:\\dev\\app" });
    const turn = adapter.send("x");
    const request = spawner.last.writtenWith("method", "turn/start")[0]!;
    spawner.last.emit({ id: request.id, error: { message: "turn rejected" } });
    await expect(turn).resolves.toEqual({ status: "failed", text: "turn rejected" });
  });

  it("thread/compact/start の error 応答はターンを failed にする", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    const turn = adapter.compact();
    const request = proc.writtenWith("method", "thread/compact/start")[0]!;
    proc.emit({ id: request.id, error: { message: "compact rejected" } });
    await expect(turn).resolves.toEqual({ status: "failed", text: "compact rejected" });
  });

  it("compact は thread/compact/start を送り、そのターンの完了で resolve する。前のターンの発言は持ち越さない", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    const first = adapter.send("a");
    await flush();
    proc.emit(agentMessage("long essay"));
    proc.emit(turnCompleted("completed"));
    await first;

    const compacted = adapter.compact();
    expect(adapter.status).toBe("busy");
    await flush();
    expect(proc.writtenWith("method", "thread/compact/start")[0]!.params).toEqual({ threadId: THREAD_ID });
    proc.emit({ method: "turn/started", params: { threadId: THREAD_ID, turn: { id: "turn-compact" } } });
    await adapter.interrupt();
    expect(proc.writtenWith("method", "turn/interrupt")[0]!.params).toEqual({ threadId: THREAD_ID, turnId: "turn-compact" });
    proc.emit({ method: "item/completed", params: { item: { type: "contextCompaction" } } });
    proc.emit(turnCompleted("completed"));
    await expect(compacted).resolves.toEqual({ status: "completed", text: "" });
  });

  it("前のターンの発言を次のターンの結果に持ち越さない", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    const first = adapter.send("a");
    await flush();
    proc.emit(agentMessage("A"));
    proc.emit(turnCompleted("completed"));
    await first;

    const second = adapter.send("b");
    await flush();
    proc.emit(turnCompleted("interrupted"));
    await expect(second).resolves.toEqual({ status: "interrupted", text: "" });
  });

  it("interrupt は turn/interrupt を送り、interrupted で終える", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    const turn = adapter.send("long");
    await flush();
    await adapter.interrupt();
    expect(proc.writtenWith("method", "turn/interrupt")[0]!.params).toEqual({ threadId: THREAD_ID, turnId: TURN_ID });
    proc.emit(turnCompleted("interrupted"));
    await expect(turn).resolves.toEqual({ status: "interrupted", text: "" });
  });

  it("turn ID の確定前に interrupt されたら、確定後に turn/interrupt を送る", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    const turn = adapter.send("long");
    await adapter.interrupt();
    expect(proc.writtenWith("method", "turn/interrupt")).toHaveLength(0);
    await flush();
    expect(proc.writtenWith("method", "turn/interrupt")[0]!.params).toEqual({ threadId: THREAD_ID, turnId: TURN_ID });
    proc.emit(turnCompleted("interrupted"));
    await expect(turn).resolves.toEqual({ status: "interrupted", text: "" });
  });

  it("failed で終わったターンは failed を返す", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    const turn = adapter.send("x");
    await flush();
    proc.emit(turnCompleted("failed"));
    await expect(turn).resolves.toMatchObject({ status: "failed" });
  });

  it("想定外の server request（承認要求等）にはエラー応答し、error イベントを出す", async () => {
    const { started, proc, events } = await setup();
    await started;
    proc.emit({ id: 99, method: "item/commandExecution/requestApproval", params: {} });
    expect(proc.written).toContainEqual(expect.objectContaining({ id: 99, error: expect.objectContaining({ code: expect.any(Number) }) }));
    expect(events.some((e) => e.type === "error" && /requestApproval/.test(e.message))).toBe(true);
  });

  it("thread/tokenUsage/updated の last.totalTokens をコンテキストの大きさとして流す", async () => {
    const { started, proc, events } = await setup();
    await started;
    proc.emit({ method: "thread/tokenUsage/updated", params: { threadId: THREAD_ID, turnId: TURN_ID, tokenUsage: {
      total: { totalTokens: 90000 }, last: { totalTokens: 30000 }, modelContextWindow: 258000,
    } } });
    expect(events).toContainEqual({ type: "context", tokens: 30000, window: 258000 });
  });

  it("account/rateLimits/updated を正規化して流す", async () => {
    const { started, proc, events } = await setup();
    await started;
    proc.emit({ method: "account/rateLimits/updated", params: { rateLimits: {
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1791199508 },
      secondary: { usedPercent: 29, windowDurationMins: 10080, resetsAt: 1791655240 },
    } } });
    expect(events).toContainEqual({
      type: "rate_limit",
      fiveHour: { usedPercent: 3, resetsAt: 1791199508 },
      weekly: { usedPercent: 29, resetsAt: 1791655240 },
    });
  });

  it("5 時間枠がないプランでは primary の週の枠を weekly として流す", async () => {
    const { started, proc, events } = await setup();
    await started;
    proc.emit({ method: "account/rateLimits/updated", params: { rateLimits: {
      primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1791846154 },
      secondary: null,
    } } });
    expect(events).toContainEqual({ type: "rate_limit", weekly: { usedPercent: 1, resetsAt: 1791846154 } });
  });

  it("5 時間でも週でもない長さの枠は無視する", async () => {
    const { started, proc, events } = await setup();
    await started;
    proc.emit({ method: "account/rateLimits/updated", params: { rateLimits: {
      primary: { usedPercent: 7, windowDurationMins: 60, resetsAt: 1791846154 },
      secondary: { usedPercent: 29, resetsAt: 1791655240 },
    } } });
    expect(events.at(-1)).toEqual({ type: "rate_limit" });
  });

  it("プロセスが落ちたら実行中のターンを failed にし、stopped になる", async () => {
    const { adapter, started, proc, events } = await setup();
    await started;
    const turn = adapter.send("x");
    await flush();
    proc.exit(1);
    await expect(turn).resolves.toMatchObject({ status: "failed" });
    expect(adapter.status).toBe("stopped");
    expect(events).toContainEqual({ type: "exit", code: 1 });
  });

  it("thread/start が失敗したら start を reject してプロセスを止める", async () => {
    // thread/start だけ自動応答せず、テストからエラー応答を返す
    const responder = defaultResponder();
    const spawner = createFakeSpawner((m) => (m.method === "thread/start" ? undefined : responder(m)));
    const adapter = new CodexAdapter(spawner.spawn);
    const started = adapter.start({ cwd: "C:\\dev\\app" });
    await flush();
    const threadStart = spawner.last.writtenWith("method", "thread/start")[0]!;
    spawner.last.emit({ id: threadStart.id, error: { message: "bad cwd" } });

    await expect(started).rejects.toThrow("bad cwd");
    expect(spawner.last.killed).toBe(true);
    expect(adapter.status).toBe("stopped");
  });

  it("起動中にプロセスが落ちたら start を reject する", async () => {
    const spawner = createFakeSpawner(() => undefined);
    const adapter = new CodexAdapter(spawner.spawn);
    const started = adapter.start({ cwd: "C:\\dev\\app" });
    spawner.last.exit(1);
    await expect(started).rejects.toThrow();
    expect(adapter.status).toBe("stopped");
  });
});

describe("CodexAdapter の subagent（docs/spikes/steer-image-subagent.md）", () => {
  it("別 thread（subagent）の通知では親のターンを終えず、親の subAgentActivity を tool として出す", async () => {
    const { adapter, started, proc, events } = await setup();
    await started;
    const turn = adapter.send("spawn");
    await flush();
    const SUB = "thr-sub";
    proc.emit({ method: "item/completed", params: { threadId: THREAD_ID, item: { type: "subAgentActivity", kind: "started", agentThreadId: SUB, agentPath: "/root/reply" } } });
    proc.emit({ method: "turn/started", params: { threadId: SUB, turn: { id: "turn-sub" } } });
    proc.emit({ method: "item/completed", params: { threadId: SUB, item: { type: "agentMessage", text: "SUB-DONE" } } });
    proc.emit({ method: "thread/tokenUsage/updated", params: { threadId: SUB, tokenUsage: { last: { totalTokens: 5 } } } });
    proc.emit({ method: "turn/completed", params: { threadId: SUB, turn: { id: "turn-sub", status: "completed" } } });
    expect(adapter.status).toBe("busy");

    proc.emit({ method: "item/completed", params: { threadId: THREAD_ID, item: { type: "agentMessage", text: "PARENT-DONE" } } });
    proc.emit(turnCompleted("completed"));
    await expect(turn).resolves.toEqual({ status: "completed", text: "PARENT-DONE" });
    expect(events).toContainEqual({ type: "tool", name: "subagent", input: "started /root/reply" });
    expect(events).not.toContainEqual({ type: "text", text: "SUB-DONE" });
    expect(events.some((e) => e.type === "context")).toBe(false);
  });
});

describe("CodexAdapter の steer", () => {
  it("実行中のターンに turn/steer を送り、turn ID が無い・失敗したら false", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    await expect(adapter.steer("x")).resolves.toBe(false);
    void adapter.send("work");
    await flush();
    const steered = adapter.steer("方針を変えて");
    await flush();
    const request = proc.writtenWith("method", "turn/steer")[0]!;
    expect(request.params).toEqual({ threadId: THREAD_ID, expectedTurnId: TURN_ID, input: [{ type: "text", text: "方針を変えて", text_elements: [] }] });
    proc.emit({ id: request.id, result: { turnId: TURN_ID } });
    await expect(steered).resolves.toBe(true);
    const rejected = adapter.steer("もう一度");
    await flush();
    const second = proc.writtenWith("method", "turn/steer")[1]!;
    proc.emit({ id: second.id, error: { message: "activeTurnNotSteerable" } });
    await expect(rejected).resolves.toBe(false);
  });
});

describe("CodexAdapter の画像", () => {
  it("画像は localImage として turn/start に並べる", async () => {
    const { adapter, started, proc } = await setup();
    await started;
    void adapter.send("見て", ["C:\\up\\a.png"]);
    await flush();
    expect(proc.writtenWith("method", "turn/start")[0]!.params).toMatchObject({
      input: [{ type: "text", text: "見て", text_elements: [] }, { type: "localImage", path: "C:\\up\\a.png" }],
    });
  });
});
