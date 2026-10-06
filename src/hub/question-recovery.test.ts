import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { EMPTY_MODEL_CATALOG } from "../agents/startup-probe.js";
import { historyItemOf } from "../web/web-ui.js";
import { WebFeed } from "../web/web-feed.js";
import { openProject } from "./project-context.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("Hub 再起動後に未回答のカードを読み直し、元の session に回答を届ける", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-question-hub-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot);
  const open = async () => {
    const agents = { claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") };
    const context = await openProject({
      projectRoot, homeDir, args: { models: {}, resume: false, web: false, serve: true }, language: "en",
      printTerminal: () => {}, notify: () => {}, displayMode: () => "normal", isCurrent: () => true,
      modelCatalog: EMPTY_MODEL_CATALOG, registerCoordinator: () => () => {}, createAgents: () => agents,
    });
    context.workspace.onEvent((runtime, event) => {
      const item = historyItemOf(event);
      if (item) context.saveFeedItem(runtime.conversationId, item);
    });
    await context.restore();
    return { context, agents };
  };
  const first = await open();
  let questionId: string;
  try {
    const runtime = first.context.workspace.current;
    void runtime.coordinator.sendToAgent("claude", "方針を確認");
    await flush();
    runtime.bus.publish({ kind: "agent", agent: "claude", event: { type: "session", sessionId: "saved-session" } });
    const result = runtime.coordinator.askUser("claude", { questions: [{ question: "方針は", options: [{ label: "A" }, { label: "B" }] }] });
    if (!result.ok) throw new Error(result.error);
    questionId = result.id;
    first.agents.claude.completeTurn();
    await flush();
  } finally { await first.context.close(); }
  const second = await open();
  try {
    const coordinator = second.context.workspace.current.coordinator;
    expect(coordinator.pendingQuestions()).toMatchObject([{ id: questionId }]);
    const feed = new WebFeed();
    second.context.showFeed(feed);
    expect(feed.recent()).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ kind: "question", id: questionId }) }));
    expect(coordinator.answer(questionId, [["B"]])).toBeUndefined();
    await flush();
    expect(second.agents.claude.starts[0]?.resumeSessionId).toBe("saved-session");
    expect(second.agents.claude.sent[0]).toContain(`Answer to your question ${questionId}:\n- 方針は: B`);
  } finally { await second.context.close(); }
});
