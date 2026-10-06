import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
