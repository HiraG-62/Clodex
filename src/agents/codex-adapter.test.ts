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

    const methods = spawner.last.written.map((m) => m.method);
    expect(methods).toEqual(["initialize", "initialized", "account/read", "thread/start"]);
    expect(spawner.last.writtenWith("method", "thread/start")[0]!.params).toMatchObject({
      cwd: "C:\\dev\\app", approvalPolicy: "never", sandbox: "workspace-write",
    });
    expect(adapter.status).toBe("idle");
    expect(adapter.sessionId).toBe(THREAD_ID);
    expect(events).toContainEqual({ type: "session", sessionId: THREAD_ID });
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
