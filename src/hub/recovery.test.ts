import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { EMPTY_MODEL_CATALOG } from "../agents/startup-probe.js";
import type { CliArgs } from "../cli/args.js";
import type { CoordinatorEvent } from "../coordinator/event-bus.js";
import { loadRecovery, saveRecovery } from "../project/recovery-store.js";
import { Hub } from "./hub.js";
import { openProject } from "./project-context.js";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("Hub recovery", () => {
  it("serve は保存された今の会話を選び、通常起動は新しい会話を選ぶ", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "clodex-recovery-selection-"));
    const projectRoot = join(homeDir, "project");
    mkdirSync(projectRoot);
    const open = async (serve: boolean) => {
      const context = await openProject({
        projectRoot,
        homeDir,
        args: { models: {}, resume: false, web: false, serve },
        language: "en",
        printTerminal: () => {},
        notify: () => {},
        notifyAgent: () => {},
        displayMode: () => "normal",
        isCurrent: () => true,
        modelCatalog: EMPTY_MODEL_CATALOG,
        registerCoordinator: () => () => {},
        createAgents: () => ({ claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") }),
      });
      await context.restore();
      return context;
    };
    const first = await open(false);
    const old = first.history.currentId;
    first.workspace.current.bus.publish({ kind: "agent", agent: "claude", event: { type: "session", sessionId: "old" } });
    await first.workspace.startNew();
    const newest = first.history.currentId;
    first.workspace.current.bus.publish({ kind: "agent", agent: "codex", event: { type: "session", sessionId: "new" } });
    await first.close();
    saveRecovery(homeDir, projectRoot, { current: old, conversations: {} });
    const serveContext = await open(true);
    expect(serveContext.history.currentId).toBe(old);
    await serveContext.close();
    const fresh = await open(false);
    expect([old, newest]).not.toContain(fresh.history.currentId);
    await fresh.close();
    saveRecovery(homeDir, projectRoot, { current: "missing", conversations: {} });
    const missing = await open(true);
    expect([old, newest]).not.toContain(missing.history.currentId);
    await missing.close();
  });

  it("Hub を再生成すると fake Adapter で中断ターンと配送待ちを復旧する", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "clodex-recovery-hub-"));
    const projectRoot = join(homeDir, "project");
    mkdirSync(projectRoot);
    const args: CliArgs = { models: {}, resume: false, web: false, serve: true };
    const agents: Array<{ claude: FakeAgentAdapter; codex: FakeAgentAdapter }> = [];
    const events: CoordinatorEvent[][] = [];
    const makeHub = () =>
      new Hub({
        homeDir,
        cwd: homeDir,
        openProject: async path => {
          const context = await openProject({
            projectRoot: path,
            homeDir,
            args,
            language: "en",
            printTerminal: () => {},
            notify: () => {},
            notifyAgent: () => {},
            displayMode: () => "normal",
            isCurrent: () => true,
            modelCatalog: EMPTY_MODEL_CATALOG,
            registerCoordinator: () => () => {},
            createAgents: () => {
              const pair = { claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") };
              agents.push(pair);
              return pair;
            },
          });
          const runtimeEvents: CoordinatorEvent[] = [];
          context.workspace.current.bus.subscribe(event => runtimeEvents.push(event));
          events.push(runtimeEvents);
          await context.restore();
          return context;
        },
      });
    const firstHub = makeHub();
    const first = await firstHub.open(projectRoot);
    const id = first.history.currentId;
    const runtime = first.workspace.current;
    void runtime.coordinator.sendToAgent("claude", "working");
    await flush();
    runtime.bus.publish({ kind: "agent", agent: "claude", event: { type: "session", sessionId: "saved" } });
    void runtime.coordinator.sendToAgent("claude", "later");
    const formal = runtime.coordinator.receiveMessage("codex", { to: "claude", type: "QUESTION", taskId: "recovery", body: "check" });
    expect(formal.ok).toBe(true);
    expect(loadRecovery(homeDir, projectRoot)?.conversations[id]).toMatchObject({
      interrupted: ["claude"],
      queue: {
        claude: [
          { kind: "input", text: "later" },
          { kind: "message", message: { body: "check" } },
        ],
      },
    });
    await firstHub.closeAll();
    expect(loadRecovery(homeDir, projectRoot)?.conversations[id]?.queue.claude).toHaveLength(2);

    const secondHub = makeHub();
    expect(secondHub.recoveryProjects()).toEqual([projectRoot]);
    const second = await secondHub.open(projectRoot);
    expect(second.history.currentId).toBe(id);
    await flush();
    const resumed = agents.at(-1)!.claude;
    expect(resumed.starts[0]).toMatchObject({ resumeSessionId: "saved" });
    expect(resumed.sent[0]).toContain("previous turn was interrupted");
    expect(events.at(-1)?.some(event => event.kind === "notice")).toBe(true);
    expect(events.at(-1)?.filter(event => event.kind === "human")).toEqual([]);
    expect(events.at(-1)?.filter(event => event.kind === "message")).toEqual([]);
    resumed.completeTurn();
    await flush();
    expect(resumed.sent[1]).toContain("later");
    resumed.completeTurn();
    await flush();
    expect(resumed.sent[2]).toContain("Message ");
    expect(resumed.sent[2]).toContain("check");
    if (!formal.ok) throw new Error("formal message was rejected");
    const followup = second.workspace.current.coordinator.receiveMessage("claude", {
      to: "codex",
      type: "RESULT",
      taskId: "recovery",
      body: "done",
      replyTo: formal.message.id,
    });
    expect(followup.ok).toBe(true);
    resumed.completeTurn();
    await flush();
    agents.at(-1)!.codex.completeTurn();
    await second.workspace.current.coordinator.whenIdle();
    expect(loadRecovery(homeDir, projectRoot)?.conversations).toEqual({});
    await secondHub.closeAll();
  });
});
