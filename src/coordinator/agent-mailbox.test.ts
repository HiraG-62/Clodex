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
