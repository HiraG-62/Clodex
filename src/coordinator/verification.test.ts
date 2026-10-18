import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import type { AgentMessage, SpecCheckResult } from "../protocol/messages.js";
import { Coordinator } from "./coordinator.js";
import { type CoordinatorEvent, EventBus } from "./event-bus.js";
import * as specCheck from "./spec-check.js";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const request = { to: "codex", type: "DELEGATE", taskId: "T", body: "実装", spec: "spec.md" };
const setup = (check?: string) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "clodex-verify-")));
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "初期化"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "spec.md"), "## 対象\n- `*.txt`\n");
  const agents = { claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") };
  const bus = new EventBus();
  const events: CoordinatorEvent[] = [];
  bus.subscribe(event => events.push(event));
  const coordinator = new Coordinator({
    projectRoot: root,
    agents,
    bus,
    mcpUrlFor: () => "http://test",
    verify: { implement: ["pnpm test"] },
    specSections: { owned: "対象" },
    ...(check ? { specCheck: check } : {}),
  });
  const result = () =>
    events
      .filter(event => event.kind === "message")
      .map(event => event.message)
      .find(message => message.type === "RESULT");
  return { root, agents, bus, coordinator, events, result };
};
afterEach(() => vi.restoreAllMocks());

it("別の worktree の specCheck と証跡を同じ場所で取得する", async () => {
  const run = vi.spyOn(specCheck, "runSpecCheck").mockResolvedValue({ command: "check spec.md", exitCode: 0, output: "" });
  const { coordinator, root, result } = setup("check {spec}");
  const worktree = join(root, ".claude", "worktrees", "task");
  writeFileSync(join(root, ".gitignore"), ".claude/\n");
  execFileSync("git", ["worktree", "add", "--detach", worktree], { cwd: root, stdio: "pipe" });
  writeFileSync(join(worktree, "spec.md"), "## 対象\n- `*.txt`\n");
  const accepted = coordinator.receiveMessage("claude", { ...request, spec: ".claude/worktrees/task/spec.md" });
  if (!accepted.ok) throw new Error(accepted.error);
  await flush();
  expect(run).toHaveBeenCalledExactlyOnceWith("check {spec}", "spec.md", worktree);
  writeFileSync(join(worktree, "a.txt"), "changed");
  coordinator.receiveMessage("codex", { to: "claude", type: "RESULT", taskId: "T", body: "完了", replyTo: accepted.message.id });
  expect(result()?.evidence).toMatchObject({ root: worktree, changed: [{ path: "a.txt", scope: "owned" }] });
  await coordinator.stop();
});

it.each([false, true])("明示 RESULT / auto RESULT に配送以後の証跡を付ける: auto=%s", async auto => {
  const { coordinator, agents, root, result } = setup();
  const accepted = coordinator.receiveMessage("claude", request);
  if (!accepted.ok) throw new Error(accepted.error);
  await flush();
  writeFileSync(join(root, "a.txt"), "new");
  agents.codex.emit({ type: "tool", name: "command", input: "pnpm test", exitCode: 0 });
  if (auto) agents.codex.completeTurn({ status: "completed", text: "完了" });
  else coordinator.receiveMessage("codex", { to: "claude", type: "RESULT", taskId: "T", body: "完了", replyTo: accepted.message.id, evidence: { fake: true } });
  await flush();
  expect(result()?.evidence).toEqual({ root, checks: [{ command: "pnpm test", ran: true, exitCode: 0 }], changed: [{ path: "a.txt", scope: "owned" }] });
  await coordinator.stop();
});

it("queued DELEGATE の基準点は配送直前に取る", async () => {
  const { coordinator, agents, root, result } = setup();
  void coordinator.sendToAgent("codex", "先行作業");
  await flush();
  const accepted = coordinator.receiveMessage("claude", request);
  if (!accepted.ok) throw new Error(accepted.error);
  writeFileSync(join(root, "before.txt"), "new");
  agents.codex.emit({ type: "tool", name: "command", input: "pnpm test", exitCode: 0 });
  agents.codex.completeTurn({ status: "completed", text: "" });
  await flush();
  coordinator.receiveMessage("codex", { to: "claude", type: "RESULT", taskId: "T", body: "完了", replyTo: accepted.message.id });
  expect(result()?.evidence).toEqual({ root, checks: [{ command: "pnpm test", ran: false }], changed: [] });
  await coordinator.stop();
});

it("steer が失敗して待機した依頼は、実際の配送直前に基準点を取り直す", async () => {
  const { coordinator, agents, root, result } = setup();
  coordinator.receiveMessage("claude", { ...request, type: "REVIEW_REQUEST" });
  await flush();
  vi.spyOn(agents.codex, "steer").mockResolvedValue(false);
  const accepted = coordinator.receiveMessage("claude", { ...request, interrupt: true });
  if (!accepted.ok) throw new Error(accepted.error);
  await flush();
  writeFileSync(join(root, "before.txt"), "new");
  agents.codex.completeTurn({ status: "completed", text: "" });
  await flush();
  coordinator.receiveMessage("codex", { to: "claude", type: "RESULT", taskId: "T", body: "完了", replyTo: accepted.message.id });
  expect(result()?.evidence?.changed).toEqual([]);
  await coordinator.stop();
});

it("FIX への RESULT は元の依頼の基準点を使う", async () => {
  const { coordinator, agents, root, result } = setup();
  const accepted = coordinator.receiveMessage("claude", request);
  if (!accepted.ok) throw new Error(accepted.error);
  await flush();
  writeFileSync(join(root, "first.txt"), "new");
  const fix = coordinator.receiveMessage("claude", { ...request, type: "FIX", replyTo: accepted.message.id });
  if (!fix.ok) throw new Error(fix.error);
  await flush();
  agents.codex.emit({ type: "tool", name: "command", input: "pnpm test", exitCode: 0 });
  coordinator.receiveMessage("codex", { to: "claude", type: "RESULT", taskId: "T", body: "完了", replyTo: fix.message.id });
  expect(result()?.evidence).toMatchObject({ checks: [{ exitCode: 0 }], changed: [{ path: "first.txt" }] });
  await coordinator.stop();
});

it("検査中も受理順に publish・配送し、検査結果は別 event にする", async () => {
  let finish!: (result: SpecCheckResult) => void;
  const run = vi.spyOn(specCheck, "runSpecCheck").mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const { coordinator, agents, events, root } = setup("check {spec}");
  coordinator.receiveMessage("claude", request);
  coordinator.receiveMessage("claude", { ...request, spec: undefined, taskId: "next" });
  await flush();
  expect(events.filter(event => event.kind === "message").map(event => event.message.taskId)).toEqual(["T", "next"]);
  expect(agents.codex.sent).toHaveLength(0);
  expect(run).toHaveBeenCalledExactlyOnceWith("check {spec}", "spec.md", root);
  finish({ command: "check spec.md", exitCode: 3, output: "診断" });
  await flush();
  expect(events.some(event => event.kind === "spec_check" && event.result.exitCode === 3)).toBe(true);
  expect(agents.codex.sent[0]).toContain("Spec check (check spec.md): exit 3");
  agents.codex.completeTurn({ status: "completed", text: "" });
  await flush();
  expect(agents.codex.sent[1]).toContain("Task: next");
  await coordinator.stop();
});

it("未設定では検査せず、基準点のない RESULT に証跡を付けない", async () => {
  const run = vi.spyOn(specCheck, "runSpecCheck");
  const { coordinator, result } = setup();
  coordinator.receiveMessage("codex", { to: "claude", type: "RESULT", taskId: "T", body: "完了", replyTo: "unknown" });
  expect(result()?.evidence).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
  await coordinator.stop();
});

it("子の会話で取得した証跡を親への転送前に付ける", async () => {
  const { root, agents, bus } = setup();
  let forwarded: AgentMessage | undefined;
  const coordinator = new Coordinator({
    projectRoot: root,
    agents,
    bus,
    mcpUrlFor: () => "http://test",
    parallelParent: { from: "claude", to: "codex", messageId: "r" },
    forwardToParent: message => {
      forwarded = message;
      return { ok: true, message };
    },
  });
  void coordinator.receiveForwardedMessage({
    ...request,
    type: "DELEGATE",
    to: "codex",
    from: "claude",
    id: "r",
    repository: root,
    createdAt: "",
    thread: "child",
  });
  await flush();
  writeFileSync(join(root, "child.txt"), "new");
  await coordinator.receiveMessageFromTool("codex", { to: "claude", type: "RESULT", taskId: "T", body: "完了", replyTo: "r" });
  expect(forwarded?.evidence?.changed).toEqual([{ path: "child.txt" }]);
  await coordinator.stop();
});
