import { describe, expect, it, vi } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { AgentMailbox } from "./agent-mailbox.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const START_OPTIONS = { cwd: "C:\\dev\\app", mcpUrl: "http://127.0.0.1:1/mcp/t/codex" };

const setup = () => {
  const agent = new FakeAgentAdapter("codex");
  const onError = vi.fn();
  const mailbox = new AgentMailbox(agent, START_OPTIONS, onError);
  return { agent, onError, mailbox };
};

describe("AgentMailbox", () => {
  it("stopped の Agent は起動してから送る", async () => {
    const { agent, mailbox } = setup();
    const result = mailbox.enqueue("hello");
    await flush();
    expect(agent.starts).toEqual([START_OPTIONS]);
    expect(agent.sent).toEqual(["hello"]);
    agent.completeTurn({ status: "completed", text: "done" });
    await expect(result).resolves.toEqual({ status: "completed", text: "done" });
  });

  it("以前の session ID があれば resume で起動する", async () => {
    const { agent, mailbox } = setup();
    agent.sessionId = "old-session";
    void mailbox.enqueue("hello");
    await flush();
    expect(agent.starts).toEqual([{ ...START_OPTIONS, resumeSessionId: "old-session" }]);
  });

  it("startOptions の resumeSessionId は、Agent に session が無いときの最初の起動で使う", async () => {
    const agent = new FakeAgentAdapter("codex");
    const mailbox = new AgentMailbox(agent, { ...START_OPTIONS, resumeSessionId: "saved" }, vi.fn());
    void mailbox.enqueue("hello");
    await flush();
    expect(agent.starts[0]).toMatchObject({ resumeSessionId: "saved" });
  });

  it("Agent の session がある（一度起動した）なら、保存された ID より Agent の session を優先する", async () => {
    const agent = new FakeAgentAdapter("codex");
    agent.sessionId = "current";
    const mailbox = new AgentMailbox(agent, { ...START_OPTIONS, resumeSessionId: "saved" }, vi.fn());
    void mailbox.enqueue("hello");
    await flush();
    expect(agent.starts[0]).toMatchObject({ resumeSessionId: "current" });
  });

  it("switchSession で指定した session（undefined なら新規）で次回起動する", async () => {
    const agent = new FakeAgentAdapter("codex");
    agent.sessionId = "current";
    const mailbox = new AgentMailbox(agent, START_OPTIONS, vi.fn());
    mailbox.switchSession("picked");
    void mailbox.enqueue("a");
    await flush();
    expect(agent.starts[0]).toMatchObject({ resumeSessionId: "picked" });

    agent.completeTurn();
    await flush();
    await agent.stop();
    mailbox.switchSession(undefined);
    void mailbox.enqueue("b");
    await flush();
    expect(agent.starts[1]).not.toHaveProperty("resumeSessionId");
  });

  it("switchSession 後の起動が失敗しても、次の試行で選んだ session を使う", async () => {
    const agent = new FakeAgentAdapter("codex");
    agent.sessionId = "current";
    const mailbox = new AgentMailbox(agent, START_OPTIONS, vi.fn());
    mailbox.switchSession("picked");
    agent.startError = new Error("boom");
    await mailbox.enqueue("a");
    agent.startError = undefined;
    void mailbox.enqueue("b");
    await flush();
    expect(agent.starts.map((s) => s.resumeSessionId)).toEqual(["picked", "picked"]);
  });

  it("起動中の Agent には start しない", async () => {
    const { agent, mailbox } = setup();
    agent.status = "idle";
    void mailbox.enqueue("hello");
    await flush();
    expect(agent.starts).toEqual([]);
    expect(agent.sent).toEqual(["hello"]);
  });

  it("配送中は current に処理中の message を持ち、ターン完了で外す", async () => {
    const { agent, mailbox } = setup();
    const message = {
      id: "msg_1", from: "claude", to: "codex", type: "QUESTION", taskId: "T-1", body: "?",
      repository: "C:\\dev\\app", createdAt: "2026-10-05T07:00:00.000Z",
    } as const;
    const first = mailbox.enqueue("envelope", message);
    const second = mailbox.enqueue("human");
    await flush();
    expect(mailbox.current).toEqual(message);
    agent.completeTurn();
    await first;
    await flush();
    expect(mailbox.current).toBeUndefined();
    agent.completeTurn();
    await second;
    expect(mailbox.current).toBeUndefined();
  });

  it("whenIdle はキューが空になりターンが終わるまで待つ", async () => {
    const { agent, mailbox } = setup();
    await mailbox.whenIdle();
    void mailbox.enqueue("first");
    let idle = false;
    void mailbox.whenIdle().then(() => (idle = true));
    await flush();
    expect(idle).toBe(false);
    agent.completeTurn();
    await flush();
    expect(idle).toBe(true);
  });

  it("enqueueCompact は送信と同じキューで直列に compact する", async () => {
    const { agent, mailbox } = setup();
    agent.status = "idle";
    const first = mailbox.enqueue("first");
    const compacted = mailbox.enqueueCompact();
    await flush();
    expect(agent.compacts).toBe(0);
    agent.completeTurn();
    await first;
    await flush();
    expect(agent.compacts).toBe(1);
    agent.completeTurn({ status: "completed", text: "" });
    await expect(compacted).resolves.toEqual({ status: "completed", text: "" });
  });

  it("停止中の Agent は compact のために起動しない", async () => {
    const { agent, mailbox, onError } = setup();
    await expect(mailbox.enqueueCompact()).resolves.toEqual({ status: "failed", text: "codex is not running" });
    expect(agent.starts).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("compact の reject を failed に変換し、次の項目へ進んで whenIdle を解放する", async () => {
    const { agent, mailbox, onError } = setup();
    agent.status = "idle";
    agent.compact = () => Promise.reject(new Error("compact failed"));
    const compacted = mailbox.enqueueCompact();
    const next = mailbox.enqueue("next");
    const idle = mailbox.whenIdle();
    await expect(compacted).resolves.toEqual({ status: "failed", text: "compact failed" });
    expect(onError).toHaveBeenCalledWith("compact failed");
    await flush();
    expect(agent.sent).toEqual(["next"]);
    agent.completeTurn();
    await next;
    await idle;
    expect(mailbox.isIdle).toBe(true);
  });

  it("前のターンが終わるまで次を送らない（FIFO）", async () => {
    const { agent, mailbox } = setup();
    const first = mailbox.enqueue("first");
    const second = mailbox.enqueue("second");
    await flush();
    expect(agent.sent).toEqual(["first"]);

    agent.completeTurn();
    await first;
    await flush();
    expect(agent.sent).toEqual(["first", "second"]);
    agent.completeTurn();
    await second;
  });

  it("close は未配送分を破棄し、以後は起動も送信もしない", async () => {
    const { agent, mailbox } = setup();
    const first = mailbox.enqueue("first");
    const second = mailbox.enqueue("second");
    await flush();
    mailbox.close();
    agent.status = "stopped";
    agent.completeTurn();
    await first;
    await expect(second).resolves.toEqual({ status: "failed", text: "mailbox is closed" });
    await expect(mailbox.enqueue("third")).resolves.toMatchObject({ status: "failed" });
    await flush();
    expect(agent.starts).toHaveLength(1);
    expect(agent.sent).toEqual(["first"]);
  });

  it("起動に失敗したら onError を呼び、failed を返して次の項目へ進む", async () => {
    const { agent, mailbox, onError } = setup();
    agent.startError = new Error("spawn codex ENOENT");
    const first = mailbox.enqueue("first");
    await expect(first).resolves.toEqual({ status: "failed", text: "spawn codex ENOENT" });
    expect(onError).toHaveBeenCalledWith("spawn codex ENOENT");

    agent.startError = undefined;
    const second = mailbox.enqueue("second");
    await flush();
    expect(agent.sent).toEqual(["second"]);
    agent.completeTurn();
    await expect(second).resolves.toMatchObject({ status: "completed" });
  });
});
