import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { ConversationHistory } from "../project/conversation-history.js";
import { type SoloMode, Coordinator } from "./coordinator.js";
import { EventBus, type CoordinatorEvent } from "./event-bus.js";
import { MAX_BODY_LENGTH, type CreateMessageResult } from "../protocol/messages.js";

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

describe("自動 RESULT", () => {
  it("依頼先が返事を送らず完了したら最終応答を依頼元へ届ける", async () => {
    const { claude, codex, events, coordinator } = setup();
    const request = coordinator.receiveMessage("claude", { ...reviewRequest, type: "DELEGATE" });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    await flush();
    codex.completeTurn({ status: "completed", text: "実装しました" });
    await flush();
    const messages = events.filter((event) => event.kind === "message").map((event) => event.message);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ from: "codex", to: "claude", type: "RESULT", taskId: "T-1",
      replyTo: request.message.id, status: "done", body: "実装しました", auto: true });
    expect(claude.sent[0]).toContain("Auto: the recipient ended its turn without send_message; this is its final reply.");
  });

  it.each(["RESULT", "QUESTION"] as const)("依頼元へ %s を送っていれば自動で返さない", async (type) => {
    const { codex, events, coordinator } = setup();
    const request = coordinator.receiveMessage("claude", reviewRequest);
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    await flush();
    const reply = coordinator.receiveMessage("codex", { to: "claude", type, taskId: "T-1", body: "返事",
      ...(type === "RESULT" ? { replyTo: request.message.id } : {}) });
    expect(reply.ok).toBe(true);
    codex.completeTurn({ status: "completed", text: "最終応答" });
    await flush();
    expect(events.filter((event) => event.kind === "message")).toHaveLength(2);
  });

  it.each(["failed", "interrupted"] as const)("%s なら自動で返さない", async (status) => {
    const { codex, events, coordinator } = setup();
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    codex.completeTurn({ status, text: "途中" });
    await flush();
    expect(events.filter((event) => event.kind === "message")).toHaveLength(1);
  });

  it("空の最終応答と返信不要の message では自動で返さない", async () => {
    const { claude, codex, events, coordinator } = setup();
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    codex.completeTurn({ status: "completed", text: "  " });
    await flush();
    coordinator.receiveMessage("claude", { to: "codex", type: "ISSUE", taskId: "T-2", body: "問題" });
    await flush();
    codex.completeTurn({ status: "completed", text: "確認" });
    await flush();
    coordinator.receiveMessage("claude", { to: "codex", type: "RESULT", taskId: "T-3", body: "結果", replyTo: "msg_older" });
    await flush();
    codex.completeTurn({ status: "completed", text: "確認" });
    await flush();
    expect(events.filter((event) => event.kind === "message")).toHaveLength(3);
    expect(claude.sent).toEqual([]);
  });

  it("実行中のターンに足した依頼からは自動 RESULT を作らない", async () => {
    const { codex, events, coordinator } = setup();
    const original = coordinator.receiveMessage("claude", reviewRequest);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    await flush();
    const correction = coordinator.receiveMessage("claude", { to: "codex", type: "QUESTION", taskId: "T-2",
      body: "追加の確認", interrupt: true });
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;
    await flush();
    expect(codex.steered).toHaveLength(1);
    codex.completeTurn({ status: "completed", text: "確認済み" });
    await flush();
    const automatic = events.flatMap((event) => event.kind === "message" && event.message.auto ? [event.message] : []);
    expect(automatic.map((message) => message.replyTo)).toEqual([original.message.id]);
  });

  it("長い最終応答を上限内で切り詰める", async () => {
    const { codex, events, coordinator } = setup();
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    codex.completeTurn({ status: "completed", text: "x".repeat(MAX_BODY_LENGTH + 200) });
    await flush();
    const messages = events.filter((event) => event.kind === "message").map((event) => event.message);
    expect(messages[1]?.body).toHaveLength(MAX_BODY_LENGTH);
    expect(messages[1]?.body.endsWith("…")).toBe(true);
  });

  it("Budget の上限なら作らずエラーを出す", async () => {
    const { codex, events, coordinator } = setup();
    coordinator.setLimits({ maxMessagesPerChain: 1, maxReviewRoundsPerChain: 3, maxDelegationsPerChain: 4, maxDelegationDepth: 2 });
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    codex.completeTurn({ status: "completed", text: "完了" });
    await flush();
    expect(events.filter((event) => event.kind === "message")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent", agent: "codex",
      event: { type: "error", message: expect.stringContaining("Budget limit reached") } }));
  });

  it("復旧した配送待ちの依頼にも自動 RESULT を返す", async () => {
    const { claude, codex, events, coordinator } = setup();
    coordinator.restore({ interrupted: [], queue: { claude: [], codex: [{ kind: "message", message: {
      id: "msg_restored", from: "claude", to: "codex", type: "DELEGATE", taskId: "R", body: "復旧した依頼",
      repository: PROJECT_ROOT, createdAt: NOW,
    } }] } });
    await flush();
    codex.completeTurn({ status: "completed", text: "復旧した作業を完了" });
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ kind: "message", message: expect.objectContaining({
      type: "RESULT", replyTo: "msg_restored", auto: true,
    }) }));
    expect(claude.sent[0]).toContain("復旧した作業を完了");
  });
});

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

  it("/context の指示は Agent にだけ送り、会話の event と配送待ちには出さない", async () => {
    const { codex, coordinator, events } = setup();
    void coordinator.sendToAgent("codex", "作業中");
    await flush();
    void coordinator.sendToAgent("codex", "画像を見て", [], true);
    expect(events).toContainEqual({ kind: "human", agent: "codex", text: "画像を見て", at: NOW });
    expect(events.filter((event) => event.kind === "human").every((event) => !event.text.includes("read_conversation"))).toBe(true);
    expect(coordinator.pendingInputs()).toContainEqual(expect.objectContaining({ agent: "codex", text: "画像を見て" }));
    expect(coordinator.recoveryState().queue.codex).toContainEqual({ kind: "input", text: "画像を見て", context: true });
    codex.completeTurn();
    await flush();
    expect(codex.sent[1]).toContain("read_conversation");
    codex.completeTurn();
  });

  it("/context の配送待ちを復旧しても指示を Agent にだけ添える", async () => {
    const { codex, coordinator } = setup();
    coordinator.restore({ interrupted: [], queue: {
      claude: [], codex: [{ kind: "input", text: "前の依頼", context: true }],
    } });
    await flush();
    expect(codex.sent[0]).toContain("前の依頼");
    expect(codex.sent[0]).toContain("read_conversation");
    codex.completeTurn();
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

  describe("利用枠の上限での停止と自動再開", () => {
    const setupLimit = () => {
      const claude = new FakeAgentAdapter("claude");
      const codex = new FakeAgentAdapter("codex");
      const bus = new EventBus(() => new Date(NOW));
      const events: CoordinatorEvent[] = [];
      bus.subscribe((e) => events.push(e));
      const coordinator = new Coordinator({ projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus, mcpUrlFor, limitResumeMarginMs: 0 });
      return { claude, events, coordinator };
    };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it("spontaneous turn の失敗で上限なら再開を予約する", async () => {
      const { claude, events, coordinator } = setupLimit();
      claude.emit({ type: "rate_limit", fiveHour: { usedPercent: 100, resetsAt: Date.now() / 1000 + 0.1 } });
      claude.emit({ type: "turn_started" });
      claude.emit({ type: "turn", result: { status: "failed", text: "You've hit your session limit" } });
      expect(coordinator.status().find((agent) => agent.id === "claude")?.holdUntil).toBeDefined();
      claude.emit({ type: "turn", result: { status: "failed", text: "limit" } });
      expect(events.filter((event) => event.kind === "notice" && /再開|resuming/i.test(event.text))).toHaveLength(1);
      await wait(200);
      expect(claude.sent[0]).toContain("usage limit has reset");
      claude.completeTurn();
    });

    it("spontaneous turn の失敗でも枠が残っていれば hold しない", () => {
      const { claude, events, coordinator } = setupLimit();
      claude.emit({ type: "rate_limit", fiveHour: { usedPercent: 80, resetsAt: Date.now() / 1000 + 3600 } });
      claude.emit({ type: "turn", result: { status: "failed", text: "error" } });
      expect(coordinator.status().find((agent) => agent.id === "claude")?.holdUntil).toBeUndefined();
      expect(events.some((event) => event.kind === "notice" && event.text.includes("claude"))).toBe(false);
    });

    it("上限の枠があるときに失敗したら配送を止め、リセット後に続きを送ってから残りを送る", async () => {
      const { claude, events, coordinator } = setupLimit();
      void coordinator.sendToAgent("claude", "first");
      void coordinator.sendToAgent("claude", "second");
      await flush();
      claude.emit({ type: "rate_limit", fiveHour: { usedPercent: 100, resetsAt: Date.now() / 1000 + 0.1 } });
      claude.emit({ type: "turn", result: { status: "failed", text: "limit" } });
      claude.completeTurn({ status: "failed", text: "limit" });
      await flush();
      expect(claude.sent).toEqual(["first"]);
      expect(events.filter((event) => event.kind === "notice" && /再開|resuming/i.test(event.text))).toHaveLength(1);
      expect(coordinator.status().find((agent) => agent.id === "claude")?.holdUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const queued = coordinator.receiveMessage("codex", { to: "claude", type: "QUESTION", taskId: "hold", body: "待機中の質問" });
      expect(queued.ok).toBe(true);
      if (queued.ok) {
        expect(coordinator.pendingMessages()).toMatchObject([{ id: queued.message.id, agent: "claude" }]);
        expect(coordinator.cancelInput(queued.message.id)).toMatchObject({ id: queued.message.id });
        expect(coordinator.pendingMessages()).toEqual([]);
      }
      expect(coordinator.recoveryState().interrupted).toEqual(["claude"]);
      expect(events).toContainEqual(expect.objectContaining({ kind: "notice", text: expect.stringContaining("claude") }));
      await wait(200);
      expect(coordinator.status().find((agent) => agent.id === "claude")?.holdUntil).toBeUndefined();
      expect(claude.sent).toHaveLength(2);
      expect(claude.sent[1]).toContain("usage limit has reset");
      claude.completeTurn();
      await flush();
      expect(claude.sent[2]).toBe("second");
    });

    it("上限の枠が無い失敗では止めず、/interrupt で待つのをやめる", async () => {
      const { claude, coordinator } = setupLimit();
      void coordinator.sendToAgent("claude", "first");
      void coordinator.sendToAgent("claude", "second");
      await flush();
      claude.emit({ type: "rate_limit", fiveHour: { usedPercent: 80, resetsAt: Date.now() / 1000 + 3600 } });
      claude.completeTurn({ status: "failed", text: "boom" });
      await flush();
      expect(claude.sent).toEqual(["first", "second"]);
      claude.emit({ type: "rate_limit", weekly: { usedPercent: 100, resetsAt: Date.now() / 1000 + 3600 } });
      void coordinator.sendToAgent("claude", "third");
      claude.completeTurn({ status: "failed", text: "limit" });
      await flush();
      expect(claude.sent).toHaveLength(2);
      await coordinator.interrupt("claude");
      await flush();
      expect(claude.sent).toEqual(["first", "second", "third"]);
    });
  });

  describe("作業を頼む message の配送の失敗", () => {
    const setupRetry = () => {
      const claude = new FakeAgentAdapter("claude");
      const codex = new FakeAgentAdapter("codex");
      const bus = new EventBus(() => new Date(NOW));
      const events: CoordinatorEvent[] = [];
      bus.subscribe((e) => events.push(e));
      let seq = 0;
      const coordinator = new Coordinator({
        projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus, mcpUrlFor, retryDelayMs: 0,
        createMessageId: () => `msg_${String(++seq).padStart(8, "0")}`,
      });
      return { claude, codex, events, coordinator };
    };
    const delegate = { to: "codex", type: "DELEGATE", taskId: "T-1", body: "implement" };

    it("1 回失敗したら同じ envelope をもう一度だけ送り、成功時は自動 RESULT を返す", async () => {
      const { claude, codex, coordinator } = setupRetry();
      coordinator.receiveMessage("claude", delegate);
      await flush();
      codex.completeTurn({ status: "failed", text: "server overloaded" });
      await flush(); await flush();
      expect(codex.sent).toHaveLength(2);
      expect(codex.sent[1]).toBe(codex.sent[0]);
      codex.completeTurn();
      await flush();
      expect(claude.sent[0]).toContain("Auto: the recipient ended its turn without send_message");
    });

    it("2 回失敗したら送信元に自分で進めるよう指示し、notice を出す", async () => {
      const { claude, codex, events, coordinator } = setupRetry();
      coordinator.receiveMessage("claude", delegate);
      await flush();
      codex.completeTurn({ status: "failed", text: "server overloaded\nretry later" });
      await flush(); await flush();
      codex.completeTurn({ status: "failed", text: "server overloaded" });
      await flush(); await flush();
      expect(codex.sent).toHaveLength(2);
      expect(claude.sent).toHaveLength(1);
      expect(claude.sent[0]).toContain("DELEGATE msg_00000001 to codex");
      expect(claude.sent[0]).toContain("server overloaded");
      expect(claude.sent[0]).toContain("Do not send it again");
      expect(events).toContainEqual(expect.objectContaining({ kind: "notice", text: expect.stringContaining("DELEGATE") }));
    });

    it("宛先が上限で待っているなら送り直さない", async () => {
      const { claude, codex, coordinator } = setupRetry();
      coordinator.receiveMessage("claude", delegate);
      await flush();
      codex.emit({ type: "rate_limit", fiveHour: { usedPercent: 100, resetsAt: Date.now() / 1000 + 3600 } });
      codex.completeTurn({ status: "failed", text: "limit" });
      await flush(); await flush();
      expect(codex.sent).toHaveLength(1);
      expect(claude.sent).toEqual([]);
      await coordinator.stop();
    });

    it("RESULT・取り消し・停止は再送しない", async () => {
      const { claude, codex, coordinator } = setupRetry();
      coordinator.receiveMessage("codex", { to: "claude", type: "RESULT", taskId: "T", body: "done", replyTo: "msg_x" });
      await flush();
      claude.completeTurn({ status: "failed", text: "boom" });
      await flush(); await flush();
      expect(claude.sent).toHaveLength(1);
      coordinator.receiveMessage("claude", delegate);
      await flush();
      const stopped = coordinator.stop();
      codex.completeTurn({ status: "failed", text: "process exited" });
      await stopped;
      await flush(); await flush();
      expect(codex.sent).toHaveLength(1);
      expect(claude.sent).toHaveLength(1);
    });
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
      { id: "claude", status: "busy", sessionId: "s-1", permission: "edit", model: undefined, modelLabel: "default", effort: undefined, models: [], usage: {}, subagents: [] },
      { id: "codex", status: "stopped", sessionId: undefined, permission: "edit", model: undefined, modelLabel: "default", effort: undefined, models: [], usage: {}, subagents: [] },
    ]);
  });

  it("subagents event の全件を状態に反映する", () => {
    const { claude, coordinator } = setup();
    claude.emit({ type: "subagents", running: [{ id: "sub-1", description: "調査" }] });
    expect(coordinator.status()[0]?.subagents).toEqual([{ id: "sub-1", description: "調査" }]);
    claude.emit({ type: "subagents", running: [] });
    expect(coordinator.status()[0]?.subagents).toEqual([]);
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
    expect(idle).toBe(false);
    claude.completeTurn();
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
  it("配送待ちの formal message を一覧に出し、ID 指定で取り消す", async () => {
    const { claude, codex, coordinator } = setup();
    void coordinator.sendToAgent("codex", "作業中");
    await flush();
    const created = coordinator.receiveMessage("claude", { to: "codex", type: "DELEGATE", taskId: "T", body: "実装して\n詳細" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(coordinator.pendingMessages()).toEqual([{
      id: created.message.id, agent: "codex", from: "claude", type: "DELEGATE", taskId: "T", text: "実装して\n詳細",
    }]);
    expect(coordinator.cancelInput(created.message.id)).toMatchObject({ id: created.message.id, agent: "codex" });
    expect(coordinator.pendingMessages()).toEqual([]);
    codex.completeTurn();
    await flush();
    expect(codex.sent).toEqual(["作業中"]);
    expect(claude.sent).toEqual([]);
  });
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
  it("/context の割り込みでは内部指示を Agent にだけ渡す", async () => {
    const { codex, events, coordinator } = setup();
    void coordinator.sendToAgent("codex", "作業中");
    await flush();
    await coordinator.steerOrSend("codex", "先ほどの会話を確認", true);
    expect(codex.steered[0]).toContain("read_conversation");
    expect(events).toContainEqual(expect.objectContaining({ kind: "human", agent: "codex", text: "先ほどの会話を確認", steer: true }));
    codex.completeTurn();
  });

  it("人間の @agent! は実行中なら steer し、実行中でなければ通常の送信にする", async () => {
    const { codex, events, coordinator } = setup();
    await expect(coordinator.steerOrSend("codex", "first")).resolves.toBe("queued");
    await flush();
    await expect(coordinator.steerOrSend("codex", "fix")).resolves.toBe("steered");
    expect(codex.steered).toEqual(["fix"]);
    expect(codex.sent).toEqual(["first"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "human", agent: "codex", text: "fix", steer: true, steerId: codex.steerIds[0] }));
    expect(codex.steerIds[0]).toMatch(/^[0-9a-f-]{36}$/);
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
  it("言語の変更後は同じ session の次の入力から新しい言語を使う", async () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    let language: "ja" | "en" = "ja";
    const coordinator = new Coordinator({ projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus: new EventBus(), mcpUrlFor, language: () => language });
    void coordinator.sendToAgent("claude", "最初");
    await flush();
    expect(claude.sent[0]).toContain("Japanese");
    claude.completeTurn();
    await flush();
    language = "en";
    void coordinator.sendToAgent("claude", "次");
    await flush();
    expect(claude.sent[1]).toContain("English");
    expect(claude.starts).toHaveLength(1);
    claude.completeTurn();
    await coordinator.stop();
  });
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

describe("Coordinator の spec の差分", () => {
  const project = mkdtempSync(join(tmpdir(), "clodex-spec-diff-"));
  const write = (text: string) => writeFileSync(join(project, "design.md"), text);
  const changesOf = (result: CreateMessageResult) => (result.ok ? result.message.specChanges : "rejected");
  const send = (coordinator: ReturnType<typeof setup>["coordinator"], from: "claude" | "codex" = "claude") =>
    changesOf(coordinator.receiveMessage(from, { ...reviewRequest, to: from === "claude" ? "codex" : "claude", spec: "design.md" }));

  it("宛先に前回渡した中身と比べて、変わった節の見出しを付ける", () => {
    const { coordinator } = setup(project);
    write("# 設計\n本文\n");
    expect(send(coordinator)).toBeUndefined();
    expect(send(coordinator)).toEqual([]);
    write("# 設計\n本文\n## 追記\n足した\n");
    expect(send(coordinator)).toEqual(["## 追記"]);
  });
  it("宛先ごとに記録する", () => {
    const { coordinator } = setup(project);
    write("# 設計\n本文\n");
    send(coordinator);
    expect(send(coordinator, "codex")).toBeUndefined();
  });
  it("Agent が送った specChanges は使わない", () => {
    const { coordinator } = setup(project);
    write("# 設計\n本文\n");
    expect(changesOf(coordinator.receiveMessage("claude", { ...reviewRequest, spec: "design.md", specChanges: ["偽"] })))
      .toBeUndefined();
  });
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

describe("Coordinator の solo（DESIGN.md §11 Solo）", () => {
  const withSolo = () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    let solo: SoloMode | undefined = "free";
    const coordinator = new Coordinator({ projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus: new EventBus(), mcpUrlFor, solo: () => solo });
    return { claude, codex, coordinator, setSolo: (mode: SoloMode | undefined) => { solo = mode; } };
  };

  it("solo の間は send_message を拒否し、解除すれば受け付ける", async () => {
    const { codex, coordinator, setSolo } = withSolo();
    const rejected = coordinator.receiveMessage("claude", reviewRequest);
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("solo") });
    await flush();
    expect(codex.sent).toEqual([]);
    setSolo(undefined);
    expect(coordinator.receiveMessage("claude", reviewRequest).ok).toBe(true);
    await coordinator.stop();
  });

  it("solo の間は人の入力に自分で作業する 1 行を足す", async () => {
    const { claude, coordinator, setSolo } = withSolo();
    void coordinator.sendToAgent("claude", "作業");
    await flush();
    expect(claude.sent[0]).toContain("Solo mode");
    claude.completeTurn();
    await flush();
    setSolo(undefined);
    void coordinator.sendToAgent("claude", "次");
    await flush();
    expect(claude.sent[1]).not.toContain("Solo mode");
    claude.completeTurn();
    await coordinator.stop();
  });

  it("idle は作業中・配送待ちが無いときだけ true", async () => {
    const { claude, coordinator } = withSolo();
    expect(coordinator.idle()).toBe(true);
    void coordinator.sendToAgent("claude", "作業");
    await flush();
    expect(coordinator.idle()).toBe(false);
    claude.completeTurn();
    await flush();
    expect(coordinator.idle()).toBe(true);
    await coordinator.stop();
  });
});

describe("solo 解除の配送通知", () => {
  const setupReleased = () => {
    const pending = new Set(["claude", "codex"] as const);
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const coordinator = new Coordinator({ projectRoot: PROJECT_ROOT, agents: { claude, codex }, bus: new EventBus(), mcpUrlFor,
      soloReleased: (agent) => pending.has(agent), consumeSoloReleased: (agent) => pending.delete(agent) });
    return { claude, codex, pending, coordinator };
  };

  it("人の入力には Agent ごとに最初の配送だけ解除の 1 行を足す", async () => {
    const { claude, codex, coordinator } = setupReleased();
    void coordinator.sendToAgent("claude", "最初");
    await flush();
    expect(claude.sent[0]).toContain("Solo mode is off");
    claude.completeTurn();
    await flush();
    void coordinator.sendToAgent("claude", "次");
    void coordinator.sendToAgent("codex", "別 Agent");
    await flush();
    expect(claude.sent[1]).not.toContain("Solo mode is off");
    expect(codex.sent[0]).toContain("Solo mode is off");
  });

  it("先に届く formal message と割り込みにも解除の 1 行を足す", async () => {
    const { claude, codex, coordinator } = setupReleased();
    coordinator.receiveMessage("claude", reviewRequest);
    await flush();
    expect(codex.sent[0]).toContain("Solo mode is off");
    void coordinator.sendToAgent("claude", "作業");
    await flush();
    expect(claude.sent[0]).toContain("Solo mode is off");
    await coordinator.steerOrSend("claude", "修正");
    expect(claude.steered[0]).not.toContain("Solo mode is off");
  });

  it("解除後の最初の配送が steer なら、その割り込みに一度だけ足す", async () => {
    const { codex, pending, coordinator } = setupReleased();
    pending.clear();
    void coordinator.sendToAgent("codex", "作業中");
    await flush();
    pending.add("codex");
    await coordinator.steerOrSend("codex", "追加指示");
    expect(codex.steered[0]).toContain("Solo mode is off");
    expect(pending.has("codex")).toBe(false);
    await coordinator.steerOrSend("codex", "さらに追加");
    expect(codex.steered[1]).not.toContain("Solo mode is off");
  });

  it("解除前から送信待ちの入力にも、配送時に通知を足す", async () => {
    const { codex, pending, coordinator } = setupReleased();
    pending.clear();
    void coordinator.sendToAgent("codex", "実行中");
    await flush();
    void coordinator.sendToAgent("codex", "送信待ち");
    expect(coordinator.pendingInputs().map((item) => item.text)).toEqual(["送信待ち"]);
    pending.add("codex");
    codex.completeTurn();
    await flush();
    expect(codex.sent[1]).toContain("Solo mode is off");
    expect(coordinator.pendingInputs()).toEqual([]);
  });

  it("再起動後の Coordinator も保存された通知待ちを使う", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "clodex-release-")), "state.json");
    const history = new ConversationHistory(path, { resumeLatest: false });
    history.setSolo("free");
    history.setSolo(undefined);
    const id = history.currentId;
    const first = new FakeAgentAdapter("claude");
    const before = new Coordinator({ projectRoot: PROJECT_ROOT, agents: { claude: first, codex: new FakeAgentAdapter("codex") },
      bus: new EventBus(), mcpUrlFor, soloReleased: (agent) => history.soloReleasedOf(id, agent),
      consumeSoloReleased: (agent) => history.consumeSoloReleased(id, agent) });
    void before.sendToAgent("claude", "最初");
    await flush();
    expect(first.sent[0]).toContain("Solo mode is off");
    await before.stop();
    const restored = new ConversationHistory(path, { resumeLatest: true });
    const codex = new FakeAgentAdapter("codex");
    const after = new Coordinator({ projectRoot: PROJECT_ROOT, agents: { claude: new FakeAgentAdapter("claude"), codex },
      bus: new EventBus(), mcpUrlFor, soloReleased: (agent) => restored.soloReleasedOf(id, agent),
      consumeSoloReleased: (agent) => restored.consumeSoloReleased(id, agent) });
    void after.sendToAgent("codex", "再開");
    await flush();
    expect(codex.sent[0]).toContain("Solo mode is off");
    expect(restored.current.soloReleased).toBeUndefined();
  });
});
