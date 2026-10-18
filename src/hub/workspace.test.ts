import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { Coordinator } from "../coordinator/coordinator.js";
import { type CoordinatorEvent, EventBus } from "../coordinator/event-bus.js";
import { type Conversation, ConversationHistory } from "../project/conversation-history.js";
import type { WorktreeResult } from "../project/worktree.js";
import type { AgentMessage } from "../protocol/messages.js";
import { type ConversationRuntime, Workspace } from "./workspace.js";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const ROOT = "C:\\dev\\app";

interface FakeRuntime extends ConversationRuntime {
  claude: FakeAgentAdapter;
  codex: FakeAgentAdapter;
  closed: boolean;
}

const setup = (
  worktree: WorktreeResult = { ok: true, worktree: { workDir: "C:\\dev\\app-wt", branch: "clodex/wt" } },
  beforeCreate?: () => Promise<void>,
  projectRoot = ROOT,
) => {
  let currentProject = true;
  const history = new ConversationHistory(join(mkdtempSync(join(tmpdir(), "clodex-ws-")), "state.json"), { resumeLatest: false });
  const created: FakeRuntime[] = [];
  let workspace: Workspace;
  const createRuntimeCalls = vi.fn();
  const createRuntime = async (conversation: Conversation): Promise<FakeRuntime> => {
    createRuntimeCalls();
    await beforeCreate?.();
    const bus = new EventBus();
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const workDir = conversation.workDir ?? projectRoot;
    const coordinator = new Coordinator({
      projectRoot: workDir,
      agents: { claude, codex },
      bus,
      mcpUrlFor: () => "http://x",
      retryDelayMs: 0,
      startParallel: message => workspace.startParallel(conversation.id, message),
      deliverToThread: (thread, message) => workspace.deliverToThread(thread, message),
      threadRequestState: (thread, requestId, to) => workspace.threadRequestState(thread, requestId, to),
      ...(conversation.parent
        ? {
            parallelParent: { from: conversation.parent.from, to: conversation.parent.to, messageId: conversation.parent.messageId },
            forwardToParent: (message: AgentMessage) => workspace.forwardToParent(conversation, message),
            forwardFailureToParent: (message: AgentMessage, error: string) => workspace.forwardFailureToParent(conversation, message, error),
          }
        : {}),
    });
    const runtime: FakeRuntime = {
      conversationId: conversation.id,
      get workDir() {
        return coordinator.workDir;
      },
      bus,
      coordinator,
      claude,
      codex,
      closed: false,
      close: async () => {
        runtime.closed = true;
      },
    };
    created.push(runtime);
    return runtime;
  };
  const notify = vi.fn();
  workspace = new Workspace({
    notifyAgent: notify,
    history,
    projectRoot,
    isCurrentProject: () => currentProject,
    createRuntime,
    createWorktree: async () => worktree,
  });
  const seen: Array<{ conversationId: string; event: CoordinatorEvent; current: boolean }> = [];
  workspace.onEvent((runtime, event, current) => seen.push({ conversationId: runtime.conversationId, event, current }));
  return {
    history,
    workspace,
    created,
    createRuntimeCalls,
    seen,
    notify,
    setCurrentProject: (value: boolean) => {
      currentProject = value;
    },
  };
};

describe("Workspace", () => {
  it.each([false, true])("親の編集は同じ作業ディレクトリの子だけに渡す: worktree=%s", async worktree => {
    const { workspace, created } = setup();
    await workspace.init();
    const parent = created[0]!;
    void parent.coordinator.sendToAgent("codex", "先行作業");
    await flush();
    const result = await parent.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "T",
      body: "並列",
      parallel: true,
      worktree,
    });
    if (!result.ok) throw new Error(result.error);
    await flush();
    const child = created[1]!;
    const record = vi.spyOn(child.coordinator, "recordPeerFiles");
    parent.claude.emit({ type: "tool", name: "Edit", input: "", files: ["src/a.ts"] });
    expect(record).toHaveBeenCalledTimes(worktree ? 0 : 1);
    if (!worktree) expect(record).toHaveBeenCalledWith("claude", ["src/a.ts"]);
  });
  it("並列の依頼への ADD・NOTE・CANCEL を子の作業中のターンへ届ける", async () => {
    const { workspace, created } = setup();
    await workspace.init();
    const parent = workspace.current;
    void parent.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await parent.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-1",
      body: "並列の依頼",
      parallel: true,
    });
    if (!request.ok) throw new Error("依頼の作成失敗");
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    const childMessages: AgentMessage[] = [];
    child.bus.subscribe(event => {
      if (event.kind === "message") childMessages.push(event.message);
    });
    for (const type of ["ADD", "NOTE", "CANCEL"] as const) {
      const result = await parent.coordinator.receiveMessageFromTool("claude", {
        to: "codex",
        type,
        taskId: "P-1",
        replyTo: request.message.id,
        body: `${type} の本文`,
      });
      expect(result).toMatchObject({ ok: true, message: { thread: request.message.thread, interrupt: true } });
      await flush();
      expect(child.codex.steered.at(-1)).toContain(`Type: ${type}`);
    }
    child.codex.completeTurn({ status: "completed", text: "途中までの作業" });
    await flush();
    expect(childMessages.filter(message => message.auto)).toEqual([]);
    expect(
      await parent.coordinator.receiveMessageFromTool("claude", {
        to: "codex",
        type: "CANCEL",
        taskId: "P-1",
        replyTo: request.message.id,
        body: "中止",
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("already finished") });
  });
  it("作業中への parallel は子の会話の新しい session に届き、今の会話を変えない", async () => {
    const { workspace, history, created } = setup();
    await workspace.init();
    const parentId = history.currentId;
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const sent = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-1",
      body: "独立した作業",
      parallel: true,
    });
    expect(sent).toMatchObject({ ok: true, message: { parallel: true, thread: expect.any(String) } });
    if (!sent.ok) return;
    expect(history.currentId).toBe(parentId);
    expect(history.list().find(conversation => conversation.id === sent.message.thread)).toMatchObject({
      title: "P-1（並列）",
      parent: { conversationId: parentId, messageId: sent.message.id, from: "claude", to: "codex" },
    });
    await flush();
    const child = created.find(runtime => runtime.conversationId === sent.message.thread)!;
    expect(child.codex.starts).toHaveLength(1);
    expect(child.codex.starts[0]).not.toHaveProperty("resumeSessionId");
    expect(child.codex.sent[0]).toContain("Parallel: yes");
    expect(child.claude.starts).toHaveLength(0);
    child.codex.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("作業中でなければ parallel でも今の会話に配送する", async () => {
    const { workspace, history, created } = setup();
    await workspace.init();
    const startParallel = vi.spyOn(workspace, "startParallel");
    const sent = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-2",
      body: "通常配送",
      parallel: true,
    });
    expect(sent).toMatchObject({ ok: true, message: { parallel: true } });
    if (sent.ok) expect(sent.message.thread).toBeUndefined();
    expect(history.list().filter(conversation => conversation.parent)).toHaveLength(0);
    expect(startParallel).not.toHaveBeenCalled();
    await flush();
    expect(created).toHaveLength(1);
    expect(created[0]!.codex.sent[0]).toContain("通常配送");
    created[0]!.codex.completeTurn();
  });

  it("待機中でも parallel と worktree の指定があれば子の会話に配送する", async () => {
    const { workspace, history, created } = setup();
    await workspace.init();
    const parent = created[0]!;
    await parent.codex.start({ cwd: ROOT });
    expect(parent.codex.status).toBe("idle");
    const startParallel = vi.spyOn(workspace, "startParallel");
    const sent = await parent.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-IDLE-WT",
      body: "独立した作業",
      parallel: true,
      worktree: true,
    });
    expect(sent).toMatchObject({ ok: true, message: { thread: expect.any(String) } });
    expect(startParallel).toHaveBeenCalledOnce();
    if (!sent.ok) throw new Error(sent.error);
    expect(history.currentId).toBe(parent.conversationId);
    await flush();
    const child = created.find(runtime => runtime.conversationId === sent.message.thread)!;
    expect(child.codex.starts[0]?.cwd).toBe("C:\\dev\\app-wt");
    expect(child.codex.sent[0]).toContain("独立した作業");
    expect(parent.codex.sent).toHaveLength(0);
    child.codex.completeTurn();
  });

  it("worktree の準備に失敗したら受理せず子の会話を残さない", async () => {
    const { workspace, history, created } = setup({ ok: false, error: "fatal: no HEAD\nmore detail" });
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const sent = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-3",
      body: "worktree",
      parallel: true,
      worktree: true,
    });
    expect(sent).toMatchObject({ ok: false, error: expect.stringContaining("fatal: no HEAD") });
    expect(history.list().filter(conversation => conversation.parent)).toHaveLength(0);
    expect(created).toHaveLength(1);
    created[0]!.codex.completeTurn();
  });

  it("子の runtime を作れなければ受理せず会話を残さない", async () => {
    const beforeCreate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("runtime failed"));
    const { workspace, history, created } = setup(undefined, beforeCreate);
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const sent = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-FAILED",
      body: "並列作業",
      parallel: true,
    });
    expect(sent).toMatchObject({ ok: false, error: expect.stringContaining("runtime failed") });
    expect(history.list().filter(conversation => conversation.parent)).toHaveLength(0);
    expect(created).toHaveLength(1);
    created[0]!.codex.completeTurn();
  });

  it("worktree の作成が例外で失敗しても受理せず会話を残さない", async () => {
    const { workspace, history, created } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    vi.spyOn(workspace, "startParallel").mockRejectedValueOnce(new Error("fatal: git failed"));
    const sent = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-THROWN",
      body: "並列作業",
      parallel: true,
      worktree: true,
    });
    expect(sent).toMatchObject({ ok: false, error: expect.stringContaining("fatal: git failed") });
    expect(history.list().filter(conversation => conversation.parent)).toHaveLength(0);
    expect(created).toHaveLength(1);
    created[0]!.codex.completeTurn();
  });

  it("worktree 指定の子は新しい作業場所を使う", async () => {
    const { workspace, history, created } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const sent = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-WT",
      body: "並列作業",
      parallel: true,
      worktree: true,
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const child = history.list().find(conversation => conversation.id === sent.message.thread);
    expect(child).toMatchObject({ workDir: "C:\\dev\\app-wt", branch: "clodex/wt" });
    await flush();
    expect(created.find(runtime => runtime.conversationId === child?.id)?.codex.starts[0]?.cwd).toBe("C:\\dev\\app-wt");
    created.find(runtime => runtime.conversationId === child?.id)?.codex.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("worktree の子には子の repository と親の未コミット spec を届ける", async () => {
    const root = mkdtempSync(join(tmpdir(), "clodex-parallel-spec-"));
    const workDir = join(root, "child-worktree");
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(root, "docs", "task.md"), "未コミットの設計", "utf8");
    const { workspace, created } = setup({ ok: true, worktree: { workDir, branch: "clodex/child" } }, undefined, root);
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const sent = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-SPEC",
      body: "調査",
      parallel: true,
      worktree: true,
      spec: "docs/task.md",
    });
    if (!sent.ok) throw new Error("parallel request rejected");
    await flush();
    const child = created.find(runtime => runtime.conversationId === sent.message.thread)!;
    expect(child.codex.sent[0]).toContain(`Repository: ${workDir}`);
    expect(readFileSync(join(workDir, "docs", "task.md"), "utf8")).toBe("未コミットの設計");
    child.codex.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("子の QUESTION は親に届き、親の ANSWER は子の作業中ターンに届く", async () => {
    const { workspace, created, seen } = setup();
    await workspace.init();
    const parent = workspace.current;
    void parent.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await parent.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-4",
      body: "調査",
      parallel: true,
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    const question = await child.coordinator.receiveMessageFromTool("codex", {
      to: "claude",
      type: "QUESTION",
      taskId: "P-4",
      body: "確認事項",
    });
    expect(question).toMatchObject({ ok: true, message: { thread: request.message.thread } });
    if (!question.ok) return;
    await flush();
    expect(parent.coordinator.pendingMessages()).toEqual([]);
    expect(created[0]!.claude.sent[0]).toContain("確認事項");
    expect(child.claude.starts).toHaveLength(0);
    const answer = await parent.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "ANSWER",
      taskId: "P-4",
      replyTo: question.message.id,
      body: "回答",
    });
    expect(answer).toMatchObject({ ok: true, message: { thread: request.message.thread } });
    await flush();
    expect(child.codex.steered.at(-1)).toContain("回答");
    expect(
      seen.some(entry => entry.conversationId === parent.conversationId && entry.event.kind === "message" && entry.event.message.id === question.message.id),
    ).toBe(true);
    child.codex.completeTurn();
    parent.coordinator.status();
    created[0]!.claude.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("子からの parallel 指定を拒否し、親子の返信経路を保つ", async () => {
    const { workspace, created } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-NESTED",
      body: "調査",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    const rejected = await child.coordinator.receiveMessageFromTool("codex", {
      to: "claude",
      type: "DELEGATE",
      taskId: "P-NESTED",
      body: "追加依頼",
      parallel: true,
      worktree: true,
    });
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("parallel") });
    expect(child.claude.starts).toHaveLength(0);
    const question = await child.coordinator.receiveMessageFromTool("codex", {
      to: "claude",
      type: "QUESTION",
      taskId: "P-NESTED",
      body: "確認",
    });
    if (!question.ok) throw new Error("child question rejected");
    await flush();
    const answer = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "ANSWER",
      taskId: "P-NESTED",
      replyTo: question.message.id,
      body: "回答",
    });
    expect(answer.ok).toBe(true);
    await flush();
    expect(child.codex.steered.at(-1)).toContain("回答");
    child.codex.completeTurn();
    created[0]!.claude.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("子の人間向けの会話で始めたやり取りは子の中で配送する", async () => {
    const { workspace, created, seen } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-LOCAL",
      body: "親からの依頼",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    void child.coordinator.sendToAgent("claude", "人からの指示");
    await flush();
    const question = await child.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "QUESTION",
      taskId: "LOCAL",
      body: "子の質問",
    });
    if (!question.ok) throw new Error("local question rejected");
    child.codex.completeTurn({ status: "completed", text: "親の作業完了" });
    await flush();
    const answer = await child.coordinator.receiveMessageFromTool("codex", {
      to: "claude",
      type: "ANSWER",
      taskId: "LOCAL",
      replyTo: question.message.id,
      body: "子の回答",
    });
    expect(answer.ok).toBe(true);
    await flush();
    expect(child.claude.steered.at(-1)).toContain("子の回答");
    expect(
      seen.some(
        entry =>
          entry.conversationId === created[0]!.conversationId &&
          entry.event.kind === "message" &&
          entry.event.message.id === (answer.ok ? answer.message.id : ""),
      ),
    ).toBe(false);
    child.claude.completeTurn();
    child.codex.completeTurn();
    created[0]!.claude.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("子への配送が二度失敗したら親の送信元に fallback と notice を届ける", async () => {
    const { workspace, created, seen } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-FAIL",
      body: "調査",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    child.codex.completeTurn({ status: "failed", text: "server error" });
    await flush();
    await flush();
    child.codex.completeTurn({ status: "failed", text: "server error" });
    await flush();
    await flush();
    expect(child.claude.starts).toHaveLength(0);
    expect(created[0]!.claude.sent[0]).toContain("Do not send it again");
    expect(seen).toContainEqual(
      expect.objectContaining({ conversationId: created[0]!.conversationId, event: expect.objectContaining({ kind: "notice", level: "warn" }) }),
    );
    created[0]!.claude.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("子から転送された message は親の人向けターンを handoff にしない", async () => {
    const { workspace, created, seen } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-NOTIFY",
      body: "調査",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    await flush();
    void workspace.current.coordinator.sendToAgent("claude", "人からの依頼");
    await flush();
    created[0]!.claude.emit({ type: "turn_started" });
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    const notice = await child.coordinator.receiveMessageFromTool("codex", {
      to: "claude",
      type: "ISSUE",
      taskId: "P-NOTIFY",
      body: "共有",
    });
    expect(notice.ok).toBe(true);
    await flush();
    created[0]!.claude.emit({ type: "turn", result: { status: "completed", text: "完了" } });
    created[0]!.claude.completeTurn();
    await flush();
    const turn = seen.find(
      entry =>
        entry.conversationId === created[0]!.conversationId &&
        entry.event.kind === "agent" &&
        entry.event.agent === "claude" &&
        entry.event.event.type === "turn",
    );
    expect(turn).toBeDefined();
    expect(turn?.event).not.toHaveProperty("handoff");
    child.codex.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("子の自動 RESULT は親へ届き、親の chain の Budget で数える", async () => {
    const { workspace, created, seen } = setup();
    await workspace.init();
    const parent = workspace.current;
    void parent.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await parent.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-5",
      body: "実装",
      parallel: true,
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    child.codex.completeTurn({ status: "completed", text: "完了" });
    await flush();
    const automatic = seen.find(entry => entry.conversationId === parent.conversationId && entry.event.kind === "message" && entry.event.message.auto);
    expect(automatic?.event).toMatchObject({ kind: "message", message: { type: "RESULT", thread: request.message.thread, body: "完了" } });
    expect(child.claude.starts).toHaveLength(0);
    expect(created[0]!.claude.sent[0]).toContain("完了");
    for (let index = 0; index < 6; index++) {
      const sent = await child.coordinator.receiveMessageFromTool("codex", {
        to: "claude",
        type: "ISSUE",
        taskId: "P-5",
        replyTo: request.message.id,
        body: `issue ${index}`,
      });
      expect(sent.ok).toBe(true);
    }
    const exceeded = await child.coordinator.receiveMessageFromTool("codex", {
      to: "claude",
      type: "ISSUE",
      taskId: "P-5",
      replyTo: request.message.id,
      body: "too many",
    });
    expect(exceeded).toMatchObject({ ok: false, error: expect.stringContaining("maxMessagesPerChain") });
    created[0]!.claude.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("親の依頼への RESULT のターンが終わったら子の Agent を止め、次の配送で resume する", async () => {
    const { workspace, created } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-STOP",
      body: "調査",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    const result = await child.coordinator.receiveMessageFromTool("codex", {
      to: "claude",
      type: "RESULT",
      taskId: "P-STOP",
      replyTo: request.message.id,
      status: "done",
      body: "完了",
    });
    expect(result.ok).toBe(true);
    expect(child.codex.status).toBe("busy");
    child.codex.completeTurn();
    child.codex.emit({ type: "turn", result: { status: "completed", text: "完了" } });
    await flush();
    expect(child.codex.status).toBe("stopped");
    expect(workspace.allRuntimes()).toContain(child);
    const followup = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "QUESTION",
      taskId: "P-STOP",
      replyTo: result.ok ? result.message.id : undefined,
      body: "追加確認",
    });
    expect(followup.ok).toBe(true);
    await flush();
    expect(child.codex.starts).toHaveLength(2);
    expect(child.codex.starts[1]).toMatchObject({ resumeSessionId: "codex-session" });
    child.codex.completeTurn();
    created[0]!.claude.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("自動 RESULT の後も子の Agent を止める", async () => {
    const { workspace, created } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-AUTO-STOP",
      body: "調査",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    child.codex.completeTurn({ status: "completed", text: "完了" });
    await flush();
    await flush();
    expect(child.codex.status).toBe("stopped");
    created[0]!.claude.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("RESULT 後に子の mailbox に返信が残る間は止めない", async () => {
    const { workspace, created } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-QUEUED",
      body: "調査",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    const result = await child.coordinator.receiveMessageFromTool("codex", {
      to: "claude",
      type: "RESULT",
      taskId: "P-QUEUED",
      replyTo: request.message.id,
      status: "done",
      body: "完了",
    });
    if (!result.ok) throw new Error("child result rejected");
    const followup = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "QUESTION",
      taskId: "P-QUEUED",
      replyTo: result.message.id,
      body: "追加確認",
    });
    expect(followup.ok).toBe(true);
    await flush();
    child.codex.completeTurn();
    child.codex.emit({ type: "turn", result: { status: "completed", text: "完了" } });
    await flush();
    expect(child.codex.status).toBe("busy");
    expect(child.codex.sent.at(-1)).toContain("追加確認");
    child.codex.completeTurn();
    await flush();
    expect(child.codex.status).toBe("stopped");
    created[0]!.claude.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("RESULT のターンが上限待ちに入った子 Agent は止めない", async () => {
    const { workspace, created } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-HOLD",
      body: "調査",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    await flush();
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    const result = await child.coordinator.receiveMessageFromTool("codex", {
      to: "claude",
      type: "RESULT",
      taskId: "P-HOLD",
      replyTo: request.message.id,
      status: "done",
      body: "完了",
    });
    expect(result.ok).toBe(true);
    child.codex.emit({ type: "rate_limit", fiveHour: { usedPercent: 100, resetsAt: Date.now() / 1000 + 3600 } });
    child.codex.completeTurn({ status: "failed", text: "limit" });
    await flush();
    child.codex.emit({ type: "turn", result: { status: "failed", text: "limit" } });
    await flush();
    expect(child.coordinator.status().find(agent => agent.id === "codex")?.holdUntil).toBeDefined();
    expect(child.codex.status).not.toBe("stopped");
    created[0]!.claude.completeTurn();
    created[0]!.codex.completeTurn();
  });

  it("親の会話を消すと子の runtime も閉じる", async () => {
    const { workspace, history, created } = setup();
    await workspace.init();
    const parentId = history.currentId;
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-DELETE",
      body: "調査",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    const child = created.find(runtime => runtime.conversationId === request.message.thread)!;
    await workspace.startNew();
    expect(history.remove(parentId)).toBeUndefined();
    await flush();
    expect(history.list().some(conversation => conversation.id === child.conversationId)).toBe(false);
    expect(workspace.allRuntimes()).not.toContain(child);
    expect(child.closed).toBe(true);
  });
  it("同じ会話の並行 init で runtime と listener を一度だけ作る", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { workspace, created, createRuntimeCalls } = setup(undefined, () => gate);
    const listener = vi.fn();
    workspace.onRuntime(listener);
    const first = workspace.init();
    const second = workspace.init();
    expect(createRuntimeCalls).toHaveBeenCalledTimes(1);
    release!();
    await Promise.all([first, second]);
    expect(created).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("runtime の作成失敗後は次の init で再試行する", async () => {
    const beforeCreate = vi.fn().mockRejectedValueOnce(new Error("create failed")).mockResolvedValue(undefined);
    const { workspace, createRuntimeCalls } = setup(undefined, beforeCreate);
    await expect(workspace.init()).rejects.toThrow("create failed");
    await expect(workspace.init()).resolves.toBeUndefined();
    expect(createRuntimeCalls).toHaveBeenCalledTimes(2);
  });
  it("今の project の今の会話のターン終了は通知しない", async () => {
    const { workspace, notify } = setup();
    await workspace.init();
    workspace.current.bus.publish({ kind: "agent", agent: "claude", event: { type: "turn", result: { status: "completed", text: "ok" } } });
    workspace.current.bus.publish({ kind: "question", id: "q1", agent: "claude", questions: [{ question: "方針は", options: [{ label: "A" }] }] });
    expect(notify).not.toHaveBeenCalled();
  });

  it("ほかの project の今の会話のターン終了は project 名付きで通知する", async () => {
    const { workspace, notify, setCurrentProject } = setup();
    await workspace.init();
    setCurrentProject(false);
    workspace.current.bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "ok" } } });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: ROOT, kind: "reply", agent: "codex" }));
  });
  it("裏の会話で途中のターンは通知せず、人への質問とエラーは通知する", async () => {
    const { workspace, notify, setCurrentProject } = setup();
    await workspace.init();
    setCurrentProject(false);
    workspace.current.bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "途中" } }, handoff: true });
    expect(notify).not.toHaveBeenCalled();
    workspace.current.bus.publish({ kind: "question", id: "q", agent: "codex", questions: [] });
    workspace.current.bus.publish({ kind: "agent", agent: "codex", event: { type: "error", message: "エラー" } });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "question" }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });
  it("今の project の裏の会話の質問を通知する", async () => {
    const { workspace, created, notify } = setup();
    await workspace.init();
    await workspace.startNew();
    created[0]!.bus.publish({ kind: "question", id: "q1", agent: "codex", questions: [{ question: "方針は", options: [{ label: "A" }] }] });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: ROOT, kind: "question", agent: "codex" }));
  });
  it("ほかの project の質問を project 名付きで通知する", async () => {
    const { workspace, notify, setCurrentProject } = setup();
    await workspace.init();
    setCurrentProject(false);
    workspace.current.bus.publish({ kind: "question", id: "q1", agent: "claude", questions: [{ question: "方針は", options: [{ label: "A" }] }] });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: ROOT, kind: "question", agent: "claude" }));
  });
  it("裏の会話で tool を使ったターンは作業完了と判定する", async () => {
    const { workspace, notify, setCurrentProject } = setup();
    await workspace.init();
    setCurrentProject(false);
    workspace.current.bus.publish({ kind: "agent", agent: "claude", event: { type: "turn_started" } });
    workspace.current.bus.publish({ kind: "agent", agent: "claude", event: { type: "tool", name: "Read", input: "a.ts" } });
    workspace.current.bus.publish({ kind: "agent", agent: "claude", event: { type: "turn", result: { status: "completed", text: "ok" } } });
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "work", agent: "claude" }));
  });
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
    const { workspace, created, seen, notify } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "裏で進める作業");
    await flush();
    await workspace.startNew();
    created[0]!.bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "ok" } } });
    expect(seen.some(s => s.event.kind === "notice")).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ conversationTitle: "裏で進める作業", kind: "reply", agent: "codex" }));
    created[0]!.bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "failed", text: "" } } });
    await flush();
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "failed", agent: "codex" }));
    // 裏の会話の event も current: false として届く
    expect(seen.some(s => s.conversationId === created[0]!.conversationId && !s.current)).toBe(true);
  });

  it("利用枠の上限の notice は失敗の通知を置き換える", async () => {
    const { workspace, notify, setCurrentProject } = setup();
    await workspace.init();
    setCurrentProject(false);
    workspace.current.bus.publish({ kind: "agent", agent: "claude", event: { type: "turn", result: { status: "failed", text: "" } } });
    workspace.current.bus.publish({ kind: "notice", text: "上限", limitHold: { agent: "claude", time: "01:00" } });
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "limitHold", agent: "claude", time: "01:00" }));
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

  it("既存の会話を移し、起動中の Agent だけ同じ session で新しい cwd に再起動する", async () => {
    const { workspace, history, created } = setup();
    await workspace.init();
    const runtime = created[0]!;
    await runtime.claude.start({ cwd: ROOT, resumeSessionId: "old-claude" });
    const result = await workspace.moveCurrentToWorktree();
    expect(result).toEqual({ ok: true, worktree: { workDir: "C:\\dev\\app-wt", branch: "clodex/wt" } });
    expect(workspace.current).toBe(runtime);
    expect(runtime.claude.starts.at(-1)).toMatchObject({ cwd: "C:\\dev\\app-wt", resumeSessionId: "old-claude" });
    expect(runtime.codex.starts).toEqual([]);
    expect(history.current).toMatchObject({ workDir: "C:\\dev\\app-wt", branch: "clodex/wt" });
    expect(await workspace.moveCurrentToWorktree()).toMatchObject({ ok: false, reason: "already" });
  });

  it("作業中と worktree の作成失敗では会話を移さない", async () => {
    const busy = setup();
    await busy.workspace.init();
    void busy.workspace.current.coordinator.sendToAgent("claude", "作業中");
    await flush();
    expect(await busy.workspace.moveCurrentToWorktree()).toMatchObject({ ok: false, reason: "busy" });
    expect(busy.history.current.workDir).toBeUndefined();

    const failed = setup({ ok: false, error: "fatal: not a git repository" });
    await failed.workspace.init();
    expect(await failed.workspace.moveCurrentToWorktree()).toEqual({ ok: false, reason: "failed", error: "fatal: not a git repository" });
    expect(failed.history.current.workDir).toBeUndefined();
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
    expect(created.map(r => r.closed)).toEqual([true, true]);
  });

  it("runtime を作り直している間、currentIfReady は例外を出さず undefined を返す", async () => {
    const { workspace } = setup();
    await workspace.init();
    expect(workspace.currentIfReady).toBe(workspace.current);
    const restarting = workspace.restart();
    expect(workspace.currentIfReady).toBeUndefined();
    expect(() => workspace.current).toThrow();
    await restarting;
    expect(workspace.currentIfReady).toBe(workspace.current);
  });

  it("restart は子の Agent を起動せず、次の配送まで lazy に保つ", async () => {
    const { workspace, created } = setup();
    await workspace.init();
    void workspace.current.coordinator.sendToAgent("codex", "元の作業");
    await flush();
    const request = await workspace.current.coordinator.receiveMessageFromTool("claude", {
      to: "codex",
      type: "DELEGATE",
      taskId: "P-RESTART",
      body: "調査",
      parallel: true,
    });
    if (!request.ok) throw new Error("parallel request rejected");
    await flush();
    const childId = request.message.thread;
    await workspace.closeAll();
    await workspace.restart();
    const child = created.filter(runtime => runtime.conversationId === childId).at(-1)!;
    expect(child.claude.starts).toHaveLength(0);
    expect(child.codex.starts).toHaveLength(0);
  });
});
