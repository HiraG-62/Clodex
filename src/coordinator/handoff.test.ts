import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentStatus, TurnResult } from "../agents/agent-adapter.js";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { MESSAGES } from "../i18n/i18n.js";
import { Coordinator } from "./coordinator.js";
import { type CoordinatorEvent, EventBus } from "./event-bus.js";
import { createHandoffPath } from "./session-handoff.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const setup = () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "clodex-handoff-"));
  const artifactsDir = join(projectRoot, "artifacts");
  const claude = new FakeAgentAdapter("claude");
  const codex = new FakeAgentAdapter("codex");
  claude.status = "idle";
  claude.sessionId = "old-claude";
  codex.status = "idle";
  codex.sessionId = "old-codex";
  const bus = new EventBus();
  const events: CoordinatorEvent[] = [];
  bus.subscribe(event => events.push(event));
  const clearSession = vi.fn();
  const coordinator = new Coordinator({ projectRoot, artifactsDir, agents: { claude, codex }, bus, clearSession, mcpUrlFor: () => "http://localhost/mcp" });
  return { coordinator, claude, codex, artifactsDir, clearSession, events };
};

const documentPath = (agent: FakeAgentAdapter): string => {
  const path = /Write a handoff document to (.+?) for your next session:/.exec(agent.sent.at(-1) ?? "")?.[1];
  expect(path).toBeDefined();
  return path!;
};

describe("session の引き継ぎ", () => {
  it.each(["human", "message"])("資料を検証して対象だけを初期化し、次の %s 配送に一度だけ path を添える", async delivery => {
    const { coordinator, codex, claude, artifactsDir, clearSession, events } = setup();
    const handoff = coordinator.handoff("codex");
    await flush();
    const path = documentPath(codex);
    expect(dirname(path)).toBe(artifactsDir);
    expect(basename(path)).toMatch(/^handoff-codex-\d{8}-\d{6}\.md$/);
    expect(codex.sent[0]).toContain("requests you sent that are still waiting for a reply (message ID and taskId)");
    expect(clearSession).not.toHaveBeenCalled();
    writeFileSync(path, "# 決定事項\n作業の続き", "utf8");
    codex.completeTurn({ status: "completed", text: path });
    await handoff;
    expect(clearSession).toHaveBeenCalledExactlyOnceWith("codex");
    expect(coordinator.status().find(agent => agent.id === "codex")?.sessionId).toBeUndefined();
    expect(claude.status).toBe("idle");
    expect(claude.sessionId).toBe("old-claude");
    expect(codex.sent).toHaveLength(1);
    expect(codex.starts).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", text: `codex handoff: ${path}` }));
    if (delivery === "human") void coordinator.sendToAgent("codex", "続き");
    else expect(coordinator.receiveMessage("claude", { to: "codex", type: "DELEGATE", taskId: "T", body: "続き" }).ok).toBe(true);
    await flush();
    expect(codex.starts[0]).not.toHaveProperty("resumeSessionId");
    expect(codex.sent[1]).toContain(`[Clodex] Handoff: your previous session wrote ${path}. Read it before continuing.`);
    codex.completeTurn({ status: "completed", text: "" });
    await coordinator.whenIdle();
    void coordinator.sendToAgent("codex", "次の入力");
    await flush();
    expect(codex.sent[2]).not.toContain("Handoff:");
    codex.completeTurn();
    await coordinator.stop();
  });

  it.each<AgentStatus>(["busy", "starting"])("%s の Agent には送らず warn", async status => {
    const { coordinator, codex, clearSession, events } = setup();
    codex.status = status;
    await coordinator.handoff("codex");
    expect(codex.sent).toEqual([]);
    expect(clearSession).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", level: "warn", text: "codex is busy" }));
    await coordinator.stop();
  });

  it("mailbox に配送待ちがあると受け付けない", async () => {
    const { coordinator, codex, clearSession, events } = setup();
    void coordinator.sendToAgent("codex", "作業");
    await flush();
    void coordinator.sendToAgent("codex", "配送待ち");
    codex.status = "idle";
    await coordinator.handoff("codex");
    expect(codex.sent).toHaveLength(1);
    expect(clearSession).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", level: "warn", text: "codex has pending deliveries" }));
    codex.completeTurn();
    await flush();
    codex.completeTurn();
    await coordinator.stop();
  });

  it.each(["subagents", "background_tasks"] as const)("%s が動作中なら受け付けない", async type => {
    const { coordinator, codex, clearSession, events } = setup();
    codex.emit({ type, running: [{ id: "child", description: "作業" }] });
    await coordinator.handoff("codex");
    expect(codex.sent).toEqual([]);
    expect(clearSession).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", level: "warn", text: expect.stringContaining("codex") }));
    await coordinator.stop();
  });

  it.each(["DELEGATE", "REVIEW_REQUEST", "QUESTION"])("宛ての %s が未完了なら受け付けない", async type => {
    const { coordinator, codex, clearSession, events } = setup();
    expect(coordinator.receiveMessage("claude", { to: "codex", type, taskId: "T", body: "依頼" }).ok).toBe(true);
    await flush();
    codex.status = "idle";
    await coordinator.handoff("codex");
    expect(codex.sent).toHaveLength(1);
    expect(clearSession).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", level: "warn", text: "codex has unfinished requests" }));
    codex.completeTurn({ status: "completed", text: "" });
    await coordinator.stop();
  });

  it("返事がなくても依頼のターンが終了していれば受け付ける", async () => {
    const { coordinator, codex, clearSession } = setup();
    expect(coordinator.receiveMessage("claude", { to: "codex", type: "QUESTION", taskId: "T", body: "判断" }).ok).toBe(true);
    await flush();
    codex.completeTurn({ status: "interrupted", text: "" });
    await coordinator.whenIdle();
    const handoff = coordinator.handoff("codex");
    await flush();
    writeFileSync(documentPath(codex), "# 決定事項", "utf8");
    codex.completeTurn();
    await handoff;
    expect(clearSession).toHaveBeenCalledExactlyOnceWith("codex");
    await coordinator.stop();
  });

  it("送った依頼の返事待ちがあっても受け付ける", async () => {
    const { coordinator, codex, claude, clearSession } = setup();
    expect(coordinator.receiveMessage("codex", { to: "claude", type: "QUESTION", taskId: "T", body: "判断" }).ok).toBe(true);
    await flush();
    const handoff = coordinator.handoff("codex");
    await flush();
    const path = documentPath(codex);
    writeFileSync(path, "# 返事待ち", "utf8");
    codex.completeTurn();
    await handoff;
    expect(clearSession).toHaveBeenCalledExactlyOnceWith("codex");
    expect(claude.status).toBe("busy");
    claude.completeTurn({ status: "completed", text: "" });
    await coordinator.stop();
  });

  it.each<TurnResult["status"]>(["failed", "interrupted"])("ターンが %s なら資料があっても切り替えない", async status => {
    const { coordinator, codex, clearSession, events } = setup();
    const handoff = coordinator.handoff("codex");
    await flush();
    writeFileSync(documentPath(codex), "# 資料", "utf8");
    codex.completeTurn({ status, text: "中断" });
    await handoff;
    expect(clearSession).not.toHaveBeenCalled();
    expect(codex.sessionId).toBe("old-codex");
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", level: "warn", text: "codex handoff failed" }));
    await coordinator.stop();
  });

  it.each(["missing", "empty", "directory"])("資料が %s なら切り替えない", async kind => {
    const { coordinator, codex, clearSession, events } = setup();
    const handoff = coordinator.handoff("codex");
    await flush();
    const path = documentPath(codex);
    if (kind === "empty") writeFileSync(path, "");
    if (kind === "directory") mkdirSync(path);
    codex.completeTurn({ status: "completed", text: path });
    await handoff;
    expect(clearSession).not.toHaveBeenCalled();
    expect(codex.status).toBe("idle");
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", level: "warn", text: "codex handoff failed" }));
    await coordinator.stop();
  });

  it.each([undefined, "saved-session"])("停止中なら session %s を外すだけでターンを起こさない", async sessionId => {
    const { coordinator, codex, clearSession } = setup();
    codex.status = "stopped";
    codex.sessionId = sessionId;
    await coordinator.handoff("codex");
    expect(clearSession).toHaveBeenCalledExactlyOnceWith("codex");
    expect(codex.sent).toEqual([]);
    expect(codex.starts).toEqual([]);
    expect(coordinator.status().find(agent => agent.id === "codex")?.sessionId).toBeUndefined();
    await coordinator.stop();
  });

  it("資料作成中に届いた入力を停止せず、引き継ぎ失敗を通知する", async () => {
    const { coordinator, codex, clearSession, events } = setup();
    const handoff = coordinator.handoff("codex");
    await flush();
    writeFileSync(documentPath(codex), "# 資料", "utf8");
    const next = coordinator.sendToAgent("codex", "追加の作業");
    codex.completeTurn();
    await handoff;
    await flush();
    expect(clearSession).not.toHaveBeenCalled();
    expect(codex.sent[1]).toBe("追加の作業");
    expect(codex.sessionId).toBe("old-codex");
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", level: "warn", text: "codex handoff failed" }));
    codex.completeTurn();
    await next;
    await coordinator.stop();
  });

  it("session の切り替えが失敗しても reject せず、資料の通知を次の配送に積まない", async () => {
    const { coordinator, codex, clearSession, events } = setup();
    const stop = vi.spyOn(codex, "stop").mockRejectedValueOnce(new Error("stop failed"));
    const handoff = coordinator.handoff("codex");
    await flush();
    writeFileSync(documentPath(codex), "# 資料", "utf8");
    codex.completeTurn();
    await expect(handoff).resolves.toBeUndefined();
    expect(clearSession).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: "notice", level: "warn", text: "codex handoff failed" }));
    void coordinator.sendToAgent("codex", "続き");
    await flush();
    expect(codex.sent[1]).not.toContain("Handoff:");
    codex.completeTurn();
    stop.mockRestore();
    await coordinator.stop();
  });

  it("資料作成中の二重要求でターンを増やさない", async () => {
    const { coordinator, codex, clearSession } = setup();
    const handoff = coordinator.handoff("codex");
    await coordinator.handoff("codex");
    await flush();
    expect(codex.sent).toHaveLength(1);
    writeFileSync(documentPath(codex), "# 資料", "utf8");
    codex.completeTurn();
    await handoff;
    expect(clearSession).toHaveBeenCalledExactlyOnceWith("codex");
    await coordinator.stop();
  });

  it.each(["ja", "en"] as const)("%s の token 警告は handoff を勧める", language => {
    expect(MESSAGES[language]["notice.threadTokenWarn"]).toContain("/handoff {agent}");
  });
});

describe("引き継ぎの資料の名前", () => {
  it("端末の時間帯の時刻を付ける", () => {
    const dir = mkdtempSync(join(tmpdir(), "clodex-handoff-name-"));
    const now = new Date(2026, 9, 18, 0, 18, 25);
    expect(basename(createHandoffPath(dir, "claude", now))).toBe("handoff-claude-20261018-001825.md");
  });
});
