import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { Coordinator } from "./coordinator.js";
import { EventBus, type CoordinatorEvent } from "./event-bus.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const NOW = "2026-10-05T07:00:00.000Z";
const PROJECT_ROOT = "C:\\dev\\app";
const mcpUrlFor = (agent: string) => `http://127.0.0.1:5000/mcp/token-${agent}`;

const setup = (projectRoot = PROJECT_ROOT) => {
  let seq = 0;
  const claude = new FakeAgentAdapter("claude");
  const codex = new FakeAgentAdapter("codex");
  const bus = new EventBus(() => new Date(NOW));
  const events: CoordinatorEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const coordinator = new Coordinator({
    projectRoot,
    agents: { claude, codex },
    bus,
    mcpUrlFor,
    createMessageId: () => `msg_${String(++seq).padStart(8, "0")}`,
  });
  return { claude, codex, events, coordinator };
};

const reviewRequest = { to: "codex", type: "REVIEW_REQUEST", taskId: "T-1", body: "review please", files: ["a.ts"] };

describe("Coordinator", () => {
  it("復旧状態の変化を知らせ、stop 時は直前の状態を保持する", async () => {
    const { claude, coordinator } = setup();
    const states: unknown[] = [];
    coordinator.onRecoveryChange(() => states.push(coordinator.recoveryState()));
    void coordinator.sendToAgent("claude", "working");
    void coordinator.sendToAgent("claude", "next", ["shot.png"]);
    await flush();
    expect(coordinator.recoveryState()).toMatchObject({
      interrupted: ["claude"], queue: { claude: [{ kind: "input", text: "next", images: ["shot.png"] }] },
    });
    const before = states.length;
    await coordinator.stop();
    expect(states).toHaveLength(before);
    expect(coordinator.recoveryState().queue.claude).toHaveLength(1);
    claude.completeTurn();
  });

  it("配送・完了・cancel・discard のたびに復旧状態を更新する", async () => {
    const { claude, coordinator } = setup();
    const states: ReturnType<typeof coordinator.recoveryState>[] = [];
    coordinator.onRecoveryChange(() => states.push(coordinator.recoveryState()));
    void coordinator.sendToAgent("claude", "first");
    await flush();
    expect(states.some((state) => state.interrupted.includes("claude"))).toBe(true);
    void coordinator.sendToAgent("claude", "cancel me");
    const queued = states.at(-1)?.queue.claude;
    expect(queued).toEqual([{ kind: "input", text: "cancel me" }]);
    coordinator.cancelInput();
    expect(states.at(-1)?.queue.claude).toEqual([]);
    coordinator.receiveMessage("codex", { to: "claude", type: "QUESTION", taskId: "T", body: "check" });
    expect(states.at(-1)?.queue.claude[0]?.kind).toBe("message");
    await coordinator.interrupt();
    expect(states.at(-1)?.queue.claude).toEqual([]);
    claude.completeTurn();
    await flush();
    expect(coordinator.recoveryState().interrupted).toEqual([]);
  });

  it("復旧では続きを先に送り、元の queue を積み直し、human event を出さない", async () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const bus = new EventBus();
    const events: CoordinatorEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const coordinator = new Coordinator({
      projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus, mcpUrlFor,
      resumeSessionIds: { claude: "saved" },
    });
    const formal = { id: "old", from: "codex" as const, to: "claude" as const, type: "REVIEW_REQUEST" as const,
      taskId: "T", body: "review", repository: PROJECT_ROOT, createdAt: NOW };
    coordinator.restore({ interrupted: ["claude", "codex"], queue: {
      claude: [{ kind: "input", text: "first" }, { kind: "message", message: formal }],
      codex: [],
    } });
    await flush();
    expect(claude.sent[0]).toContain("Clodex restarted and your previous turn was interrupted");
    expect(codex.sent).toEqual([]);
    expect(events.filter((event) => event.kind === "human")).toEqual([]);
    expect(events.some((event) => event.kind === "notice")).toBe(true);
    claude.completeTurn();
    await flush();
    expect(claude.sent[1]).toBe("first");
    claude.completeTurn();
    await flush();
    expect(claude.sent[2]).toContain("Message old");
    const sent = coordinator.receiveMessage("claude", { to: "codex", type: "RESULT", taskId: "T", body: "done", replyTo: "old" });
    expect(sent.ok).toBe(true);
  });
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
      instructions: (agent) => (agent === "codex" ? "You are codex." : undefined),
    });
    coordinator.receiveMessage("claude", reviewRequest);
    void coordinator.sendToAgent("claude", "hi");
    await flush();
    expect(codex.starts[0]).toMatchObject({ instructions: "You are codex." });
    expect(claude.starts[0]).not.toHaveProperty("instructions");
  });

  it("起動時の設定（model・effort）は setModel / setEffort で保持し、AgentStartOptions には渡さない", async () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const coordinator = new Coordinator({
      projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus: new EventBus(), mcpUrlFor,
      settings: { claude: { model: "haiku", effort: "high" }, codex: { effort: "low" } },
    });
    expect([claude.model, claude.effort, codex.model, codex.effort]).toEqual(["haiku", "high", undefined, "low"]);
    void coordinator.sendToAgent("claude", "hi");
    await flush();
    expect(claude.starts[0]).not.toHaveProperty("model");
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

  it("Claude の model / effort を通常の入力と同じ順序で配送する", async () => {
    const { claude, coordinator } = setup();
    claude.setModel = async (model) => claude.send(`/model ${model}`);
    claude.setEffort = async (level) => claude.send(`/effort ${level}`);
    const first = coordinator.sendToAgent("claude", "first");
    const model = coordinator.setModel("haiku", "claude");
    const effort = coordinator.setEffort("high", "claude");
    const last = coordinator.sendToAgent("claude", "last");
    await flush();
    expect(claude.sent).toEqual(["first"]);
    claude.completeTurn();
    await first;
    await flush();
    expect(claude.sent).toEqual(["first", "/model haiku"]);
    claude.completeTurn();
    await model;
    await flush();
    expect(claude.sent).toEqual(["first", "/model haiku", "/effort high"]);
    claude.completeTurn();
    await effort;
    await flush();
    expect(claude.sent).toEqual(["first", "/model haiku", "/effort high", "last"]);
    claude.completeTurn();
    await last;
  });

  it("Codex の設定も mailbox で busy ターンの完了を待つ", async () => {
    const { codex, coordinator } = setup();
    const first = coordinator.sendToAgent("codex", "first");
    const model = coordinator.setModel("gpt-6-sol", "codex");
    const effort = coordinator.setEffort("high", "codex");
    await flush();
    expect(codex.model).toBeUndefined();
    expect(codex.effort).toBeUndefined();
    codex.completeTurn();
    await first;
    await Promise.all([model, effort]);
    expect(codex.model).toBe("gpt-6-sol");
    expect(codex.effort).toBe("high");
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
      { id: "claude", status: "busy", sessionId: "s-1", permission: "edit", model: undefined, modelLabel: "default", effort: undefined, models: [], usage: {} },
      { id: "codex", status: "stopped", sessionId: undefined, permission: "edit", model: undefined, modelLabel: "default", effort: undefined, models: [], usage: {} },
    ]);
  });

  it("status に Agent の rate_limit から集計した利用状況を含める", () => {
    const { claude, coordinator } = setup();
    claude.emit({ type: "rate_limit", fiveHour: { usedPercent: 12, resetsAt: Date.now() / 1000 + 3600 } });
    expect(coordinator.status()[0]!.usage).toMatchObject({ fiveHourPercent: 12 });
  });

  it("起動時の利用枠を UsageMonitor に渡し、後の Agent event を優先する", () => {
    const { claude, events, coordinator } = setup();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    coordinator.applyStartupUsage({ claude: { type: "rate_limit", fiveHour: { usedPercent: 95, resetsAt: reset } } });
    expect(coordinator.status()[0]?.usage.fiveHourPercent).toBe(95);
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice" }));
    claude.emit({ type: "rate_limit", fiveHour: { usedPercent: 20, resetsAt: reset } });
    coordinator.applyStartupUsage({ claude: { type: "rate_limit", fiveHour: { usedPercent: 95, resetsAt: reset } } });
    expect(coordinator.status()[0]?.usage.fiveHourPercent).toBe(20);
  });

  it("setPermission は指定 Agent、省略時は全 Agent の権限を変える", async () => {
    const { claude, codex, coordinator } = setup();
    await coordinator.setPermission("full", "codex");
    expect([claude.permission, codex.permission]).toEqual(["edit", "full"]);
    await coordinator.setPermission("read-only");
    expect([claude.permission, codex.permission]).toEqual(["read-only", "read-only"]);
  });

  it("model と effort を Agent に設定し、status に反映する", async () => {
    const { claude, codex, coordinator } = setup();
    await coordinator.setModel("haiku", "claude");
    await coordinator.setEffort("low");
    expect([claude.model, codex.model]).toEqual(["haiku", undefined]);
    expect([claude.effort, codex.effort]).toEqual(["low", "low"]);
    expect(coordinator.status().map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: "haiku", effort: "low" }, { model: undefined, effort: "low" },
    ]);
  });

  it("起動時の権限レベルを Agent ごとに設定する", () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    new Coordinator({
      projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus: new EventBus(), mcpUrlFor,
      settings: { claude: { permission: "full" }, codex: { permission: "read-only" } },
    });
    expect([claude.permission, codex.permission]).toEqual(["full", "read-only"]);
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
    // 停止中は古い session ではなく、次の起動で使う session を見せる
    expect(coordinator.status().map((agent) => agent.sessionId)).toEqual(["c-old", undefined]);

    void coordinator.sendToAgent("claude", "hi");
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    expect(claude.starts[0]).toMatchObject({ resumeSessionId: "c-old" });
    expect(codex.starts[0]).not.toHaveProperty("resumeSessionId");
  });

  it("switchSessions の stop 待機中に届いた項目は新 session で配送する", async () => {
    const { claude, coordinator } = setup();
    claude.status = "idle";
    claude.sessionId = "old";
    let finishStop: (() => void) | undefined;
    claude.stop = () => new Promise<void>((resolve) => {
      finishStop = () => { claude.status = "stopped"; resolve(); };
    });
    const switching = coordinator.switchSessions({ claude: "new" }, ["claude"]);
    const delivered = coordinator.sendToAgent("claude", "during stop");
    await flush();
    expect(claude.sent).toEqual([]);
    finishStop?.();
    await switching;
    await flush();
    expect(claude.starts[0]).toMatchObject({ resumeSessionId: "new" });
    expect(claude.sent).toEqual(["during stop"]);
    claude.completeTurn();
    await delivered;
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

describe("Coordinator の取り消しと割り込み", () => {
  it("配送待ちの人間の入力を一覧にし、ID 省略時は最後のものを取り消す", async () => {
    const { codex, events, coordinator } = setup();
    void coordinator.sendToAgent("codex", "first");
    await flush();
    void coordinator.sendToAgent("codex", "second");
    void coordinator.sendToAgent("codex", "third");
    expect(coordinator.pendingInputs()).toEqual([
      { id: "in2", agent: "codex", text: "second" }, { id: "in3", agent: "codex", text: "third" },
    ]);
    expect(coordinator.cancelInput()).toEqual({ id: "in3", agent: "codex", text: "third" });
    expect(coordinator.cancelInput("in2")).toEqual({ id: "in2", agent: "codex", text: "second" });
    expect(coordinator.cancelInput("in1")).toBeUndefined();
    expect(events.filter((e) => e.kind === "notice")).toHaveLength(2);
    codex.completeTurn();
    await flush();
    expect(codex.sent).toEqual(["first"]);
  });

  it("Agent 指定なしの /interrupt は配送待ちの formal message を破棄し、やり取りの chain を閉じる", async () => {
    const { claude, codex, events, coordinator } = setup();
    void coordinator.sendToAgent("claude", "human work");
    await flush();
    // claude の依頼を codex が処理中に、codex が claude へ質問する（claude は作業中なので配送待ち）
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    expect(coordinator.receiveMessage("codex", { to: "claude", type: "QUESTION", taskId: "T-1", body: "which?" }).ok).toBe(true);

    await coordinator.interrupt();
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", text: expect.stringMatching(/discarded 1/) }));
    // 処理中だった依頼の chain には、もう送れない
    const reply = coordinator.receiveMessage("codex", { to: "claude", type: "RESULT", taskId: "T-1", body: "done", replyTo: "msg_00000001" });
    expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/stopped by the human/) });

    claude.completeTurn();
    codex.completeTurn({ status: "interrupted", text: "" });
    await flush();
    expect(claude.sent).toEqual(["human work"]);
  });
});

describe("Coordinator の割り込み（steer）", () => {
  it("人間の @agent! は実行中なら steer し、実行中でなければ通常の送信にする", async () => {
    const { codex, events, coordinator } = setup();
    await expect(coordinator.steerOrSend("codex", "first")).resolves.toBe("queued");
    await flush();
    await expect(coordinator.steerOrSend("codex", "fix")).resolves.toBe("steered");
    expect(codex.steered).toEqual(["fix"]);
    expect(codex.sent).toEqual(["first"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "human", agent: "codex", text: "fix", steer: true }));
  });

  it("interrupt: true は宛先が送信元からの message を処理中のときだけ steer する", async () => {
    const { claude, codex, coordinator } = setup();
    // codex が claude の依頼を処理中
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    const correction = { to: "codex", type: "ISSUE", taskId: "T-1", body: "a.ts ではなく b.ts", interrupt: true };
    expect(coordinator.receiveMessage("claude", correction).ok).toBe(true);
    await flush();
    expect(codex.steered).toHaveLength(1);
    expect(codex.steered[0]).toContain("Interrupt: yes");
    // claude は codex からの message を処理していないので、codex からの interrupt はキューに積む
    void coordinator.sendToAgent("claude", "human work");
    await flush();
    coordinator.receiveMessage("codex", { to: "claude", type: "QUESTION", taskId: "T-1", body: "?", interrupt: true });
    await flush();
    expect(claude.steered).toEqual([]);
  });
});

describe("Coordinator の画像", () => {
  it("人間の入力に添えた画像を Agent に渡す", async () => {
    const { codex, coordinator } = setup();
    void coordinator.sendToAgent("codex", "見て", ["C:/up/a.png"]);
    await flush();
    expect(codex.sentImages).toEqual([["C:/up/a.png"]]);
  });
});

describe("Coordinator の言語の 1 行（DESIGN.md §13 Language）", () => {
  const withLanguage = () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const bus = new EventBus();
    const events: CoordinatorEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const coordinator = new Coordinator({ projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus, mcpUrlFor, language: "ja" });
    return { claude, codex, events, coordinator };
  };

  it("人の入力を Agent に渡すときだけ末尾に言語の 1 行を足し、表示・送信待ちには足さない", async () => {
    const { claude, events, coordinator } = withLanguage();
    void coordinator.sendToAgent("claude", "直して");
    void coordinator.sendToAgent("claude", "次も");
    await flush();
    expect(claude.sent[0]).toMatch(/^直して\n\n\[Clodex\] .*Japanese/);
    expect(events).toContainEqual(expect.objectContaining({ kind: "human", text: "直して" }));
    expect(coordinator.pendingInputs()).toEqual([{ id: "in2", agent: "claude", text: "次も" }]);
  });

  it("割り込み（steer）にも言語の 1 行を足す", async () => {
    const { codex, coordinator } = withLanguage();
    void coordinator.sendToAgent("codex", "作業");
    await flush();
    await coordinator.steerOrSend("codex", "追加");
    expect(codex.steered[0]).toMatch(/^追加\n\n\[Clodex\] .*Japanese/);
  });

  it("言語の指定が無ければ足さない", async () => {
    const { claude, coordinator } = setup();
    void coordinator.sendToAgent("claude", "そのまま");
    await flush();
    expect(claude.sent).toEqual(["そのまま"]);
  });
});

describe("Coordinator の役割の反映", () => {
  it("instructions は起動のたびに引くので、変えた役割は次の起動から使う", async () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    let role = "old";
    const coordinator = new Coordinator({
      projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus: new EventBus(), mcpUrlFor, instructions: () => role,
    });
    void coordinator.sendToAgent("codex", "a");
    await flush();
    expect(codex.starts[0]).toMatchObject({ instructions: "old" });
    role = "new";
    codex.completeTurn();
    await codex.stop();
    void coordinator.sendToAgent("codex", "b");
    await flush();
    expect(codex.starts[1]).toMatchObject({ instructions: "new" });
  });
});

describe("Coordinator の spec 検証", () => {
  const root = mkdtempSync(join(tmpdir(), "clodex-spec-"));
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "design.md"), "設計");
  writeFileSync(join(root, "outside.md"), "外部");
  symlinkSync(root, join(project, "outside"), "junction");

  it("存在する通常ファイルを受理して配送する", async () => {
    const { coordinator, codex } = setup(project);
    expect(coordinator.receiveMessage("claude", { ...reviewRequest, spec: "design.md" })).toMatchObject({ ok: true });
    await flush();
    expect(codex.sent[0]).toContain("Spec: design.md");
  });
  it.each(["missing.md", ".", "../outside.md", "..\\outside.md", "outside/outside.md", join(project, "design.md")])(
    "%s は記録・配送せず拒否する", async (spec) => {
      const { coordinator, codex, events } = setup(project);
      expect(coordinator.receiveMessage("claude", { ...reviewRequest, spec }))
        .toMatchObject({ ok: false, error: expect.stringContaining("spec") });
      await flush();
      expect(events.filter((e) => e.kind === "message")).toEqual([]);
      expect(codex.sent).toEqual([]);
    },
  );
});

describe("人への質問", () => {
  const questions = [{ header: "方針", question: "どちらにしますか", options: [{ label: "A" }, { label: "B" }] }];
  it("質問を保存・通知し、回答は質問した Agent の次のターンに届ける", async () => {
    const { coordinator, claude, events } = setup();
    void coordinator.sendToAgent("claude", "作業");
    await flush();
    const result = coordinator.askUser("claude", { questions });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(coordinator.pendingQuestions()).toEqual([{ id: result.id, agent: "claude", questions }]);
    expect(events.at(-1)).toMatchObject({ kind: "question", id: result.id, agent: "claude", questions });
    expect(coordinator.answer(result.id, [["A"]])).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ kind: "answer", id: result.id, answers: [["A"]] });
    expect(coordinator.pendingQuestions()).toEqual([]);
    expect(claude.sent).toEqual(["作業"]);
    claude.completeTurn();
    await flush();
    expect(claude.sent[1]).toBe(`Answer to your question ${result.id}:\n- 方針: A`);
    expect(coordinator.answer(result.id, [["B"]])).toBeTypeOf("string");
  });
  it("不正な質問と不明な ID・件数違い・空回答を拒否する", () => {
    const { coordinator } = setup();
    expect(coordinator.askUser("claude", { questions: [] }).ok).toBe(false);
    expect(coordinator.answer("missing", [["A"]])).toBeTypeOf("string");
    const result = coordinator.askUser("codex", { questions });
    if (!result.ok) throw new Error(result.error);
    for (const answers of [[], [[]], [[" "]], [["A"], ["B"]], ["A"], null]) {
      expect(coordinator.answer(result.id, answers)).toBeTypeOf("string");
    }
    expect(coordinator.pendingQuestions()).toHaveLength(1);
  });
  it("未回答を復旧し、自由記述と複数回答を元の Agent に届ける", async () => {
    const first = setup().coordinator;
    const result = first.askUser("codex", { questions: [{ ...questions[0], header: undefined, multiSelect: true }] });
    if (!result.ok) throw new Error(result.error);
    const { coordinator, codex } = setup();
    coordinator.restore(first.recoveryState());
    expect(coordinator.pendingQuestions()).toEqual(first.pendingQuestions());
    expect(coordinator.answer(result.id, [["A", "自由記述"]])).toBeUndefined();
    await flush();
    expect(codex.sent[0]).toBe(`Answer to your question ${result.id}:\n- どちらにしますか: A, 自由記述`);
  });
});

it("上限到達の人向けエラーだけに /limits を添える", async () => {
  const { coordinator, events } = setup();
  coordinator.setLimits({ maxMessagesPerChain: 1, maxReviewRoundsPerChain: 3, maxDelegationsPerChain: 4, maxDelegationDepth: 2 });
  try {
    coordinator.receiveMessage("claude", { to: "codex", type: "QUESTION", taskId: "limit", body: "question" });
    await flush();
    const result = coordinator.receiveMessage("codex", { to: "claude", type: "ISSUE", taskId: "limit", body: "reply" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("/limits");
    expect(events.some((e) => e.kind === "agent" && e.event.type === "error" && e.event.message.includes("/limits messages <n>"))).toBe(true);
  } finally { await coordinator.stop(); }
});
