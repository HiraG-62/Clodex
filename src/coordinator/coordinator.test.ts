import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { Coordinator } from "./coordinator.js";
import { EventBus, type CoordinatorEvent } from "./event-bus.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const NOW = "2026-10-05T07:00:00.000Z";
const PROJECT_ROOT = "C:\\dev\\app";
const mcpUrlFor = (agent: string) => `http://127.0.0.1:5000/mcp/token-${agent}`;

const setup = () => {
  let seq = 0;
  const claude = new FakeAgentAdapter("claude");
  const codex = new FakeAgentAdapter("codex");
  const bus = new EventBus(() => new Date(NOW));
  const events: CoordinatorEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const coordinator = new Coordinator({
    projectRoot: PROJECT_ROOT,
    agents: { claude, codex },
    bus,
    mcpUrlFor,
    createMessageId: () => `msg_${String(++seq).padStart(8, "0")}`,
  });
  return { claude, codex, events, coordinator };
};

const reviewRequest = { to: "codex", type: "REVIEW_REQUEST", taskId: "T-1", body: "review please", files: ["a.ts"] };

describe("Coordinator", () => {
  it("受理した message を記録し、宛先 Agent を起動して envelope を送る", async () => {
    const { codex, events, coordinator } = setup();
    const result = coordinator.receiveMessage("claude", reviewRequest);

    expect(result).toMatchObject({ ok: true, message: { id: "msg_00000001", from: "claude", repository: PROJECT_ROOT } });
    expect(events).toContainEqual(expect.objectContaining({ kind: "message", message: expect.objectContaining({ id: "msg_00000001" }) }));

    await flush();
    expect(codex.starts).toEqual([{ cwd: PROJECT_ROOT, mcpUrl: mcpUrlFor("codex") }]);
    expect(codex.sent).toHaveLength(1);
    expect(codex.sent[0]).toContain("[Clodex] Message msg_00000001 from claude");
  });

  it("Agent ごとの instructions を起動時に渡す", async () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const coordinator = new Coordinator({
      projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus: new EventBus(), mcpUrlFor,
      instructions: { codex: "You are codex." },
    });
    coordinator.receiveMessage("claude", reviewRequest);
    void coordinator.sendToAgent("claude", "hi");
    await flush();
    expect(codex.starts[0]).toMatchObject({ instructions: "You are codex." });
    expect(claude.starts[0]).not.toHaveProperty("instructions");
  });

  it("resumeSessionIds の Agent は最初の起動で resume する", async () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const coordinator = new Coordinator({
      projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus: new EventBus(), mcpUrlFor,
      resumeSessionIds: { claude: "saved-claude" },
    });
    void coordinator.sendToAgent("claude", "hi");
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    expect(claude.starts[0]).toMatchObject({ resumeSessionId: "saved-claude" });
    expect(codex.starts[0]).not.toHaveProperty("resumeSessionId");
  });

  it("不正な message は記録も配送もせず、エラーを返す", async () => {
    const { codex, events, coordinator } = setup();
    const result = coordinator.receiveMessage("claude", { ...reviewRequest, to: "claude" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("yourself") });
    await flush();
    expect(events.filter((e) => e.kind === "message")).toEqual([]);
    expect(codex.sent).toEqual([]);
  });

  it("ACK は記録のみで配送しない", async () => {
    const { codex, events, coordinator } = setup();
    const result = coordinator.receiveMessage("claude", { to: "codex", type: "ACK", taskId: "T-1", body: "ok", replyTo: "msg_x" });
    expect(result.ok).toBe(true);
    await flush();
    expect(events.filter((e) => e.kind === "message")).toHaveLength(1);
    expect(codex.starts).toEqual([]);
  });

  it("双方向に配送できる（Codex の RESULT が Claude に届く）", async () => {
    const { claude, coordinator } = setup();
    coordinator.receiveMessage("codex", {
      to: "claude", type: "RESULT", taskId: "T-1", body: "LGTM", replyTo: "msg_prev", status: "approved",
    });
    await flush();
    expect(claude.sent[0]).toContain("Status: approved");
  });

  it("人間の入力を human event として記録する", () => {
    const { events, coordinator } = setup();
    void coordinator.sendToAgent("codex", "review this");
    expect(events).toContainEqual({ kind: "human", agent: "codex", text: "review this", at: NOW });
  });

  it("人間の入力も同じ mailbox で直列に送る", async () => {
    const { codex, coordinator } = setup();
    const human = coordinator.sendToAgent("codex", "human task");
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    expect(codex.sent).toEqual(["human task"]);
    codex.completeTurn();
    await human;
    await flush();
    expect(codex.sent).toHaveLength(2);
  });

  it("Agent の event に送信元を付けて Event Bus へ流す", () => {
    const { claude, events } = setup();
    claude.emit({ type: "text", text: "hi" });
    expect(events).toContainEqual({ kind: "agent", agent: "claude", event: { type: "text", text: "hi" }, at: NOW });
  });

  it("配送の失敗は宛先 Agent の error event として流す", async () => {
    const { codex, events, coordinator } = setup();
    codex.startError = new Error("spawn codex ENOENT");
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    expect(events).toContainEqual(expect.objectContaining({
      kind: "agent", agent: "codex", event: { type: "error", message: expect.stringContaining("ENOENT") },
    }));
  });

  it("stop は先に mailbox を閉じ、キューに残った配送で Agent を再起動しない", async () => {
    const { codex, coordinator } = setup();
    coordinator.receiveMessage("claude", reviewRequest);
    coordinator.receiveMessage("claude", { ...reviewRequest, body: "second" });
    await flush();
    expect(codex.sent).toHaveLength(1);

    const stopped = coordinator.stop();
    codex.completeTurn({ status: "failed", text: "process exited" });
    await stopped;
    await flush();
    expect(codex.status).toBe("stopped");
    expect(codex.starts).toHaveLength(1);
    expect(codex.sent).toHaveLength(1);
  });

  it("依頼の入れ子が maxDelegationDepth を超えたら拒否し、送信元の error として流す", async () => {
    const { claude, codex, events, coordinator } = setup();
    // 人間のターン中: claude -> codex（深さ 1）
    const first = coordinator.receiveMessage("claude", reviewRequest);
    expect(first.ok).toBe(true);
    await flush();
    expect(codex.sent).toHaveLength(1);

    // codex が first を処理中: codex -> claude（深さ 2）
    const second = coordinator.receiveMessage("codex", { to: "claude", type: "QUESTION", taskId: "T-1", body: "?" });
    expect(second.ok).toBe(true);
    await flush();
    expect(claude.sent).toHaveLength(1);

    // claude が second を処理中: claude -> codex（深さ 3）は拒否
    const third = coordinator.receiveMessage("claude", { to: "codex", type: "QUESTION", taskId: "T-9", body: "?" });
    expect(third).toMatchObject({ ok: false, error: expect.stringContaining("maxDelegationDepth") });
    expect(events).toContainEqual(expect.objectContaining({
      kind: "agent", agent: "claude", event: { type: "error", message: expect.stringContaining("maxDelegationDepth") },
    }));
    expect(events.filter((e) => e.kind === "message")).toHaveLength(2);
  });

  it("人間の入力を処理中のターンから送った message は新しい chain になる", async () => {
    const { claude, coordinator } = setup();
    void coordinator.sendToAgent("claude", "human task");
    await flush();
    expect(claude.sent).toEqual(["human task"]);
    // 同じ chain なら 3 回目の REVIEW_REQUEST は maxReviewRoundsPerChain で拒否されるが、各々が新しい chain なので受理される
    for (let i = 0; i < 3; i++) {
      expect(coordinator.receiveMessage("claude", { ...reviewRequest, taskId: `T-${i}` }).ok).toBe(true);
    }
  });

  it("interrupt は指定 Agent、省略時は全 Agent を interrupt する", async () => {
    const { claude, codex, coordinator } = setup();
    const calls: string[] = [];
    claude.interrupt = async () => void calls.push("claude");
    codex.interrupt = async () => void calls.push("codex");
    await coordinator.interrupt("codex");
    expect(calls).toEqual(["codex"]);
    await coordinator.interrupt();
    expect(calls).toEqual(["codex", "claude", "codex"]);
  });

  it("status は各 Agent の状態・session ID・権限レベルを返す", async () => {
    const { claude, coordinator } = setup();
    claude.status = "busy";
    claude.sessionId = "s-1";
    expect(coordinator.status()).toEqual([
      { id: "claude", status: "busy", sessionId: "s-1", permission: "edit", usage: {} },
      { id: "codex", status: "stopped", sessionId: undefined, permission: "edit", usage: {} },
    ]);
  });

  it("status に Agent の rate_limit から集計した利用状況を含める", () => {
    const { claude, coordinator } = setup();
    claude.emit({ type: "rate_limit", fiveHour: { usedPercent: 12, resetsAt: Date.now() / 1000 + 3600 } });
    expect(coordinator.status()[0]!.usage).toEqual({ fiveHourPercent: 12 });
  });

  it("setPermission は指定 Agent、省略時は全 Agent の権限を変える", async () => {
    const { claude, codex, coordinator } = setup();
    await coordinator.setPermission("full", "codex");
    expect([claude.permission, codex.permission]).toEqual(["edit", "full"]);
    await coordinator.setPermission("read-only");
    expect([claude.permission, codex.permission]).toEqual(["read-only", "read-only"]);
  });

  it("起動時の権限レベルを全 Agent に設定する", () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    new Coordinator({ projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus: new EventBus(), mcpUrlFor, permission: "read-only" });
    expect([claude.permission, codex.permission]).toEqual(["read-only", "read-only"]);
  });

  it("whenIdle は Agent 間の配送の連鎖が終わるまで待つ", async () => {
    const { claude, codex, coordinator } = setup();
    void coordinator.sendToAgent("claude", "human task");
    let idle = false;
    void coordinator.whenIdle().then(() => (idle = true));
    await flush();

    // claude のターン中に codex へ依頼し、claude のターンが終わる
    coordinator.receiveMessage("claude", reviewRequest);
    claude.completeTurn();
    await flush();
    expect(idle).toBe(false);

    codex.completeTurn();
    await flush();
    expect(idle).toBe(true);
  });

  it("switchSessions は全 Agent を止め、次回は指定の session（無ければ新規）で起動する", async () => {
    const { claude, codex, coordinator } = setup();
    claude.status = "idle";
    claude.sessionId = "c-current";
    codex.status = "idle";
    codex.sessionId = "x-current";
    await expect(coordinator.switchSessions({ claude: "c-old" })).resolves.toBeUndefined();
    expect([claude.status, codex.status]).toEqual(["stopped", "stopped"]);

    void coordinator.sendToAgent("claude", "hi");
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    expect(claude.starts[0]).toMatchObject({ resumeSessionId: "c-old" });
    expect(codex.starts[0]).not.toHaveProperty("resumeSessionId");
  });

  it("起動中や配送待ちの作業があれば switchSessions を拒否し、Agent を止めない", async () => {
    const { claude, coordinator } = setup();
    const started: Array<() => void> = [];
    claude.start = (options) => new Promise((resolve) => {
      claude.starts.push(options);
      claude.status = "starting";
      started.push(() => {
        claude.status = "idle";
        resolve();
      });
    });
    void coordinator.sendToAgent("claude", "hi");
    await flush();
    expect(claude.status).toBe("starting");
    await expect(coordinator.switchSessions({})).resolves.toMatch(/claude is busy/);
    expect(claude.status).toBe("starting");
    started[0]!();
  });

  it("switchSessions に targets を渡すと、その Agent だけを止めて新しい session にし、コンテキストを unknown に戻す", async () => {
    const { claude, codex, coordinator } = setup();
    claude.status = "idle";
    codex.status = "idle";
    codex.emit({ type: "context", tokens: 5000 });
    await expect(coordinator.switchSessions({}, ["codex"])).resolves.toBeUndefined();
    expect([claude.status, codex.status]).toEqual(["idle", "stopped"]);
    expect(coordinator.status()[1]!.usage).toEqual({});
  });

  it("targets 外の Agent が作業中でも、targets が空いていれば切り替えられる", async () => {
    const { claude, codex, coordinator } = setup();
    claude.status = "busy";
    codex.status = "idle";
    await expect(coordinator.switchSessions({}, ["codex"])).resolves.toBeUndefined();
  });

  it("実行中のターンがあれば switchSessions を拒否する", async () => {
    const { claude, coordinator } = setup();
    claude.status = "busy";
    await expect(coordinator.switchSessions({})).resolves.toMatch(/claude is busy/);
    expect(claude.status).toBe("busy");
  });

  it("compact は指定 Agent、省略時は起動中の全 Agent を compact する", async () => {
    const { claude, codex, coordinator } = setup();
    claude.status = "idle";
    codex.status = "idle";
    void coordinator.compact("codex");
    await flush();
    expect([claude.compacts, codex.compacts]).toEqual([0, 1]);
    codex.completeTurn();
    await flush();
    void coordinator.compact();
    await flush();
    expect([claude.compacts, codex.compacts]).toEqual([1, 2]);
  });

  it("stop は全 Agent を止める", async () => {
    const { claude, codex, coordinator } = setup();
    claude.status = "idle";
    codex.status = "idle";
    await coordinator.stop();
    expect(claude.status).toBe("stopped");
    expect(codex.status).toBe("stopped");
  });
});
