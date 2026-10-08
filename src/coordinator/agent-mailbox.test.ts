import { describe, expect, it, vi } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { AgentMailbox } from "./agent-mailbox.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const START_OPTIONS = { cwd: "C:\\dev\\app", mcpUrl: "http://127.0.0.1:1/mcp/t/codex" };

const setup = () => {
  const agent = new FakeAgentAdapter("codex");
  const onError = vi.fn();
  const mailbox = new AgentMailbox(agent, () => START_OPTIONS, onError);
  return { agent, onError, mailbox };
};

describe("AgentMailbox", () => {
  it("外からの hold で配送を止め、再開時に続きの指示を先に送る", async () => {
    const { agent, mailbox } = setup();
    const resumeAt = Date.now() + 60;
    mailbox.holdForLimit({ resumeAt, text: "continue" });
    const queued = mailbox.enqueue("queued");
    expect(mailbox.holding).toBe(true);
    expect(mailbox.holdUntil).toBe(new Date(resumeAt).toISOString());
    expect(agent.sent).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(agent.sent).toEqual(["continue"]);
    agent.completeTurn();
    await flush();
    expect(agent.sent).toEqual(["continue", "queued"]);
    agent.completeTurn();
    await queued;
  });

  it("hold 中と close 後の重複した hold を無視する", () => {
    const { mailbox } = setup();
    const resumeAt = Date.now() + 60_000;
    mailbox.holdForLimit({ resumeAt, text: "first" });
    mailbox.holdForLimit({ resumeAt: resumeAt + 1_000, text: "second" });
    expect(mailbox.holdUntil).toBe(new Date(resumeAt).toISOString());
    mailbox.close();
    mailbox.holdForLimit({ resumeAt, text: "after close" });
    expect(mailbox.holding).toBe(false);
    expect(mailbox.holdUntil).toBeUndefined();
  });
  it("配送時だけ hook の文言を末尾に足し、送信待ちの本文には含めない", async () => {
    const agent = new FakeAgentAdapter("codex");
    let pending = true;
    const mailbox = new AgentMailbox(agent, () => START_OPTIONS, vi.fn(), vi.fn(), () => {}, () => undefined,
      () => pending ? (pending = false, "\n\n[Clodex] Solo mode is off.") : "");
    mailbox.pause();
    const first = mailbox.enqueue("最初", { inputId: "in1", suffix: "\n言語" });
    expect(mailbox.pendingInputs).toEqual([{ id: "in1", text: "最初" }]);
    mailbox.resume();
    await flush();
    expect(agent.sent[0]).toBe("最初\n言語\n\n[Clodex] Solo mode is off.");
    agent.completeTurn();
    await first;
    const second = mailbox.enqueue("次");
    await flush();
    expect(agent.sent[1]).toBe("次");
    agent.completeTurn();
    await second;
  });
  it("上限待機中だけ再開時刻を返す", async () => {
    const agent = new FakeAgentAdapter("codex");
    const resumeAt = Date.now() + 60_000;
    const mailbox = new AgentMailbox(agent, () => START_OPTIONS, vi.fn(), vi.fn(), () => {},
      () => ({ resumeAt, text: "continue" }));
    const first = mailbox.enqueue("first");
    await flush();
    agent.completeTurn({ status: "failed", text: "limit" });
    await first;
    expect(mailbox.holdUntil).toBe(new Date(resumeAt).toISOString());
    mailbox.releaseHold();
    expect(mailbox.holdUntil).toBeUndefined();
    mailbox.close();
  });
  it("起動禁止でも session を参照でき、配送時には起動を拒否する", async () => {
    const agent = new FakeAgentAdapter("codex");
    const mailbox = new AgentMailbox(agent, () => ({ ...START_OPTIONS, resumeSessionId: "saved" }), vi.fn(), undefined,
      () => { throw new Error("セットアップ未完了"); });
    expect(mailbox.sessionId).toBe("saved");
    await expect(mailbox.enqueue("hello")).resolves.toMatchObject({ status: "failed", text: "セットアップ未完了" });
    expect(agent.starts).toEqual([]);
  });
  it("復旧用一覧には未配送の入力と message を元の順に含める", () => {
    const { mailbox } = setup();
    void mailbox.enqueue("busy");
    const formal = { id: "msg_recover", from: "claude", to: "codex", type: "QUESTION", taskId: "T", body: "?",
      repository: "C:\\dev\\app", createdAt: "2026-10-05T07:00:00.000Z" } as const;
    void mailbox.enqueue("envelope", { message: formal });
    void mailbox.enqueue("next", { inputId: "in1", images: ["shot.png"], suffix: "\nlang" });
    expect(mailbox.recoveryQueue).toEqual([
      { kind: "message", message: formal },
      { kind: "input", text: "next", images: ["shot.png"] },
    ]);
    expect(mailbox.activeSending).toBe(true);
    mailbox.close();
    expect(mailbox.recoveryQueue).toEqual([]);
  });
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
    const mailbox = new AgentMailbox(agent, () => ({ ...START_OPTIONS, resumeSessionId: "saved" }), vi.fn());
    void mailbox.enqueue("hello");
    await flush();
    expect(agent.starts[0]).toMatchObject({ resumeSessionId: "saved" });
  });

  it("Agent の session がある（一度起動した）なら、保存された ID より Agent の session を優先する", async () => {
    const agent = new FakeAgentAdapter("codex");
    agent.sessionId = "current";
    const mailbox = new AgentMailbox(agent, () => ({ ...START_OPTIONS, resumeSessionId: "saved" }), vi.fn());
    void mailbox.enqueue("hello");
    await flush();
    expect(agent.starts[0]).toMatchObject({ resumeSessionId: "current" });
  });

  it("switchSession で指定した session（undefined なら新規）で次回起動する", async () => {
    const agent = new FakeAgentAdapter("codex");
    agent.sessionId = "current";
    const mailbox = new AgentMailbox(agent, () => START_OPTIONS, vi.fn());
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
    const mailbox = new AgentMailbox(agent, () => START_OPTIONS, vi.fn());
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
    const first = mailbox.enqueue("envelope", { message });
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

  it("model / effort の設定も送信と同じ FIFO キューで待つ", async () => {
    const { agent, mailbox } = setup();
    agent.status = "idle";
    const first = mailbox.enqueue("first");
    const model = mailbox.enqueueModel("haiku");
    const effort = mailbox.enqueueEffort("high");
    const last = mailbox.enqueue("last");
    await flush();
    expect(agent.model).toBeUndefined();
    agent.completeTurn();
    await first;
    await expect(model).resolves.toMatchObject({ status: "completed" });
    await expect(effort).resolves.toMatchObject({ status: "completed" });
    await flush();
    expect(agent.model).toBe("haiku");
    expect(agent.effort).toBe("high");
    expect(agent.sent).toEqual(["first", "last"]);
    agent.completeTurn();
    await last;
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

describe("AgentMailbox の取り消しと破棄", () => {
  const message = (id: string) => ({
    id, from: "claude" as const, to: "codex" as const, type: "DELEGATE" as const, taskId: "T", body: "b",
    repository: "C:\dev\app", createdAt: "2026-10-06T00:00:00.000Z",
  });

  it("配送待ちの人間の入力を ID で取り消し、配送中のものは取り消せない", async () => {
    const { agent, mailbox } = setup();
    const first = mailbox.enqueue("first", { inputId: "in1" });
    const second = mailbox.enqueue("second", { inputId: "in2" });
    await flush();
    expect(mailbox.pendingInputs).toEqual([{ id: "in2", text: "second" }]);
    expect(mailbox.cancel("in1")).toBeUndefined();
    expect(mailbox.cancel("in2")).toBe("second");
    await expect(second).resolves.toMatchObject({ status: "interrupted" });
    agent.completeTurn();
    await first;
    await flush();
    expect(agent.sent).toEqual(["first"]);
    expect(mailbox.isIdle).toBe(true);
  });

  it("配送待ちの formal message だけを破棄し、人間の入力は残す", async () => {
    const { agent, mailbox } = setup();
    void mailbox.enqueue("busy");
    await flush();
    const delegated = mailbox.enqueue("envelope", { message: message("msg_1") });
    void mailbox.enqueue("human", { inputId: "in1" });
    expect(mailbox.discardMessages().map((m) => m.id)).toEqual(["msg_1"]);
    await expect(delegated).resolves.toMatchObject({ status: "interrupted" });
    expect(mailbox.pendingInputs).toEqual([{ id: "in1", text: "human" }]);
    agent.completeTurn();
    await flush();
    expect(agent.sent).toEqual(["busy", "human"]);
  });

  it("配送待ちの formal message を順に返し、ID で取り消す", async () => {
    const { agent, mailbox } = setup();
    void mailbox.enqueue("busy");
    await flush();
    const first = message("msg_1");
    const second = message("msg_2");
    const pending = mailbox.enqueue("one", { message: first });
    void mailbox.enqueue("two", { message: second });
    expect(mailbox.pendingMessages).toEqual([first, second]);
    expect(mailbox.cancel("msg_1")).toEqual(first);
    await expect(pending).resolves.toEqual({ status: "interrupted", text: "canceled before delivery" });
    expect(mailbox.pendingMessages).toEqual([second]);
    agent.completeTurn();
    await flush();
    expect(agent.sent).toEqual(["busy", "two"]);
    agent.completeTurn();
  });
});
