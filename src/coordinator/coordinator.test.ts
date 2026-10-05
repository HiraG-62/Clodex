import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { Coordinator } from "./coordinator.js";
import { EventBus, type CoordinatorEvent } from "./event-bus.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const NOW = "2026-10-05T07:00:00.000Z";
const PROJECT_ROOT = "C:\\dev\\app";
const mcpUrlFor = (agent: string) => `http://127.0.0.1:5000/mcp/token-${agent}`;

const setup = () => {
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
    createMessageId: () => "msg_00000001",
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

  it("stop は全 Agent を止める", async () => {
    const { claude, codex, coordinator } = setup();
    claude.status = "idle";
    codex.status = "idle";
    await coordinator.stop();
    expect(claude.status).toBe("stopped");
    expect(codex.status).toBe("stopped");
  });
});
