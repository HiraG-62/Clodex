import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { EMPTY_MODEL_CATALOG } from "../agents/startup-probe.js";
import { rebuildTimeline, applyFeedItem } from "../web/client/timeline.js";
import { WebFeed } from "../web/web-feed.js";
import { openProject } from "./project-context.js";

it("起動中・作業中の会話に戻ってもターンを中断せず、完了を一つのターンにまとめる", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-project-feed-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  const agents: FakeAgentAdapter[] = [];
  const context = await openProject({
    projectRoot, homeDir, args: { models: {}, resume: false, web: false, serve: false }, language: "en",
    printTerminal: () => {}, notify: () => {}, displayMode: () => "normal", isCurrent: () => true,
    modelCatalog: EMPTY_MODEL_CATALOG, registerCoordinator: () => () => {},
    createAgents: () => {
      const claude = new FakeAgentAdapter("claude");
      agents.push(claude);
      return { claude, codex: new FakeAgentAdapter("codex") };
    },
  });
  try {
    const feed = new WebFeed();
    context.bindFeed(feed, () => true);
    const id = context.history.currentId;
    void context.workspace.current.coordinator.sendToAgent("claude", "作業");
    context.feedStore.append(id, { type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: "2026-10-05T12:00:00Z", event: { type: "turn_started" } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    agents[0]!.status = "starting";
    context.showFeed(feed);
    expect(feed.recent()).toHaveLength(1);
    agents[0]!.status = "busy";
    await context.workspace.startNew();
    await context.workspace.switchTo(id);
    expect(feed.recent()).toHaveLength(1);
    context.showFeed(feed);
    expect(feed.recent()).toHaveLength(1);
    feed.publishEvent({ kind: "agent", agent: "claude", at: "2026-10-05T12:00:01Z", event: { type: "turn", result: { status: "completed", text: "完了" } } });
    const timeline = rebuildTimeline(feed.recent(), applyFeedItem);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "turn", status: "completed", text: "完了" });
  } finally { await context.close(); }
});

it("project の上限を保存し、既存・新規の会話と再起動に反映する", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-limits-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, ".clodex.json"), JSON.stringify({ limits: { maxMessagesPerChain: 12 } }));
  const open = () => openProject({
    projectRoot, homeDir, args: { models: {}, resume: false, web: false, serve: false }, language: "en",
    printTerminal: () => {}, notify: () => {}, displayMode: () => "normal", isCurrent: () => true,
    modelCatalog: EMPTY_MODEL_CATALOG, registerCoordinator: () => () => {},
    createAgents: () => ({ claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") }),
  });
  let context = await open();
  try {
    expect(context.limits.maxMessagesPerChain).toBe(12);
    expect(context.limits.maxDelegationDepth).toBe(2);
    const first = vi.spyOn(context.workspace.current.coordinator, "setLimits");
    await context.workspace.startNew();
    const second = vi.spyOn(context.workspace.current.coordinator, "setLimits");
    context.setLimit("messages", 1);
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ maxMessagesPerChain: 1 }));
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ maxMessagesPerChain: 1 }));
    expect(context.settingsStore.load().limits).toEqual({ maxMessagesPerChain: 1 });
    await context.workspace.startNew();
    const coordinator = context.workspace.current.coordinator;
    expect(coordinator.receiveMessage("claude", { to: "codex", type: "QUESTION", taskId: "limit", body: "question" }).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coordinator.receiveMessage("codex", { to: "claude", type: "ISSUE", taskId: "limit", body: "reply" }).ok).toBe(false);
    await context.close();
    context = await open();
    expect(context.limits.maxMessagesPerChain).toBe(1);
    context.resetLimits();
    expect(context.limits.maxMessagesPerChain).toBe(12);
    expect(context.settingsStore.load().limits).toBeUndefined();
  } finally { await context.close(); }
});
