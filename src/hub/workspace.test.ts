import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { Coordinator } from "../coordinator/coordinator.js";
import { EventBus, type CoordinatorEvent } from "../coordinator/event-bus.js";
import { ConversationHistory, type Conversation } from "../project/conversation-history.js";
import type { WorktreeResult } from "../project/worktree.js";
import { Workspace, type ConversationRuntime } from "./workspace.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const ROOT = "C:\\dev\\app";

interface FakeRuntime extends ConversationRuntime {
  claude: FakeAgentAdapter;
  codex: FakeAgentAdapter;
  closed: boolean;
}

const setup = (worktree: WorktreeResult = { ok: true, worktree: { workDir: "C:\\dev\\app-wt", branch: "clodex/wt" } }) => {
  const history = new ConversationHistory(join(mkdtempSync(join(tmpdir(), "clodex-ws-")), "state.json"), { resumeLatest: false });
  const created: FakeRuntime[] = [];
  const createRuntime = async (conversation: Conversation): Promise<FakeRuntime> => {
    const bus = new EventBus();
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const workDir = conversation.workDir ?? ROOT;
    const coordinator = new Coordinator({ projectRoot: workDir, agents: { claude, codex }, bus, mcpUrlFor: () => "http://x" });
    const runtime: FakeRuntime = {
      conversationId: conversation.id, workDir, bus, coordinator, claude, codex, closed: false,
      close: async () => { runtime.closed = true; },
    };
    created.push(runtime);
    return runtime;
  };
  const workspace = new Workspace({ history, projectRoot: ROOT, createRuntime, createWorktree: async () => worktree });
  const seen: Array<{ conversationId: string; event: CoordinatorEvent; current: boolean }> = [];
  workspace.onEvent((runtime, event, current) => seen.push({ conversationId: runtime.conversationId, event, current }));
  return { history, workspace, created, seen };
};

describe("Workspace", () => {
  it("起動時に今の会話の runtime を作り、会話の切り替えでは前の会話の Agent を止めない", async () => {
    const { history, workspace, created } = setup();
    await workspace.init();
    const first = workspace.current;
    void first.coordinator.sendToAgent("claude", "最初の会話の作業");
    await flush();
    await workspace.startNew();
    expect(workspace.current).not.toBe(first);
    expect(created).toHaveLength(2);
    expect(created[0]!.claude.status).toBe("busy");

    const firstId = first.conversationId;
    await workspace.switchTo(firstId);
    expect(workspace.current).toBe(first);
    expect(history.currentId).toBe(firstId);
    expect(created).toHaveLength(2);
  });

  it("会話ごとの状態を返す（作業中・待機中・停止中、runtime が無ければ undefined）", async () => {
    const { workspace, created } = setup();
    await workspace.init();
    const id = workspace.current.conversationId;
    expect(workspace.activity(id)).toBe("stopped");
    void workspace.current.coordinator.sendToAgent("codex", "x");
    await flush();
    expect(workspace.activity(id)).toBe("busy");
    created[0]!.codex.completeTurn();
    await flush();
    expect(workspace.activity(id)).toBe("idle");
    expect(workspace.activity("missing")).toBeUndefined();
  });

  it("今の会話でない会話のターンが終わったら、今の会話に通知する", async () => {
    const { workspace, created, seen } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "裏で進める作業");
    await flush();
    await workspace.startNew();
    created[0]!.bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "ok" } } });
    const notice = seen.find((s) => s.event.kind === "notice");
    expect(notice).toMatchObject({ conversationId: created[1]!.conversationId, current: true });
    expect(notice?.event.kind === "notice" && notice.event.text).toContain("裏で進める作業");
    // 裏の会話の event も current: false として届く
    expect(seen.some((s) => s.conversationId === created[0]!.conversationId && !s.current)).toBe(true);
  });

  it("worktree 付きの新しい会話はその作業場所で動き、作れなければ理由を返して切り替えない", async () => {
    const ok = setup();
    await ok.workspace.init();
    await expect(ok.workspace.startNew({ worktree: true })).resolves.toBeUndefined();
    expect(ok.workspace.current.workDir).toBe("C:\\dev\\app-wt");
    expect(ok.history.current).toMatchObject({ workDir: "C:\\dev\\app-wt", branch: "clodex/wt" });

    const failed = setup({ ok: false, error: "fatal: not a git repository" });
    await failed.workspace.init();
    const before = failed.workspace.current;
    await expect(failed.workspace.startNew({ worktree: true })).resolves.toMatch(/not a git repository/);
    expect(failed.workspace.current).toBe(before);
  });

  it("同じ作業場所で別の会話の Agent が作業中なら知らせる", async () => {
    const { workspace } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("claude", "作業中");
    await flush();
    await workspace.startNew();
    expect(workspace.busyElsewhereInSameDir()).toBe(true);
    await workspace.startNew({ worktree: true });
    expect(workspace.busyElsewhereInSameDir()).toBe(false);
  });

  it("closeAll ですべての runtime を閉じる", async () => {
    const { workspace, created } = setup();
    await workspace.init();
    await workspace.startNew();
    await workspace.closeAll();
    expect(created.map((r) => r.closed)).toEqual([true, true]);
  });
});
