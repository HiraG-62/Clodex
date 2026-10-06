import { describe, expect, it } from "vitest";
import type { AgentId } from "../agents/agent-adapter.js";
import type { AgentMessage, MessageType } from "../protocol/messages.js";
import { BudgetManager, DEFAULT_LIMITS } from "./budget-manager.js";

let seq = 0;
const msg = (from: AgentId, type: MessageType, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  id: `msg_${++seq}`,
  from,
  to: from === "claude" ? "codex" : "claude",
  type,
  taskId: "T-1",
  body: "x",
  repository: "C:\\dev\\app",
  createdAt: "2026-10-05T07:00:00.000Z",
  ...(type === "RESULT" || type === "ACK" ? { replyTo: "msg_prev" } : {}),
  ...extra,
});

// 数え方のテストは既定値の変更に影響されないよう、上限を明示する
const LIMITS = { maxMessagesPerChain: 4, maxReviewRoundsPerChain: 2, maxDelegationsPerChain: 2, maxDelegationDepth: 2 };

describe("BudgetManager", () => {
  it("復元した message を新しい chain の根にして、そのターンからの送信を受理する", () => {
    const budget = new BudgetManager({ maxMessagesPerChain: 2, maxReviewRoundsPerChain: 1, maxDelegationsPerChain: 2, maxDelegationDepth: 2 });
    const parent = msg("claude", "REVIEW_REQUEST");
    budget.restore(parent);
    const child = msg("codex", "RESULT");
    expect(budget.admit(child, parent)).toBeUndefined();
    expect(budget.admit(msg("codex", "RESULT"), parent)).toMatch(/maxMessagesPerChain/);
  });
  it("既定値は §14（v0.2）のとおり", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxMessagesPerChain: 8, maxReviewRoundsPerChain: 3, maxDelegationsPerChain: 4, maxDelegationDepth: 2,
    });
  });

  it("同じ chain の message が上限を超えたら拒否する", () => {
    const budget = new BudgetManager(LIMITS);
    const m1 = msg("claude", "REVIEW_REQUEST");
    expect(budget.admit(m1, undefined)).toBeUndefined();
    const m2 = msg("codex", "RESULT");
    expect(budget.admit(m2, m1)).toBeUndefined();
    const m3 = msg("claude", "REVIEW_REQUEST");
    expect(budget.admit(m3, m2)).toBeUndefined();
    const m4 = msg("codex", "RESULT");
    expect(budget.admit(m4, m3)).toBeUndefined();
    const m5 = msg("claude", "ISSUE");
    expect(budget.admit(m5, m4)).toMatch(/maxMessagesPerChain \(4\)/);
  });

  it("chain 内の REVIEW_REQUEST が上限を超えたら拒否する", () => {
    const budget = new BudgetManager({ ...LIMITS, maxMessagesPerChain: 10 });
    const r1 = msg("claude", "REVIEW_REQUEST");
    budget.admit(r1, undefined);
    const res1 = msg("codex", "RESULT");
    budget.admit(res1, r1);
    const r2 = msg("claude", "REVIEW_REQUEST");
    expect(budget.admit(r2, res1)).toBeUndefined();
    const res2 = msg("codex", "RESULT");
    budget.admit(res2, r2);
    expect(budget.admit(msg("claude", "REVIEW_REQUEST"), res2)).toMatch(/maxReviewRoundsPerChain \(2\)/);
  });

  it("chain 内の DELEGATE + QUESTION が上限を超えたら拒否する", () => {
    const budget = new BudgetManager({ ...LIMITS, maxMessagesPerChain: 10 });
    const q1 = msg("claude", "QUESTION");
    budget.admit(q1, undefined);
    const a1 = msg("codex", "RESULT");
    budget.admit(a1, q1);
    const d1 = msg("claude", "DELEGATE");
    expect(budget.admit(d1, a1)).toBeUndefined();
    const a2 = msg("codex", "RESULT");
    budget.admit(a2, d1);
    expect(budget.admit(msg("claude", "QUESTION"), a2)).toMatch(/maxDelegationsPerChain \(2\)/);
  });

  it("依頼の処理中に送った依頼は深さ +1。上限を超えたら拒否する", () => {
    const budget = new BudgetManager(LIMITS);
    const d1 = msg("claude", "REVIEW_REQUEST");
    budget.admit(d1, undefined);
    const d2 = msg("codex", "QUESTION");
    expect(budget.admit(d2, d1)).toBeUndefined();
    expect(budget.admit(msg("claude", "QUESTION"), d2)).toMatch(/maxDelegationDepth \(2\)/);
  });

  it("結果の処理中に送った依頼は同じ深さ（同じ階層での継続）", () => {
    const budget = new BudgetManager({ ...LIMITS, maxDelegationDepth: 1 });
    const r1 = msg("claude", "REVIEW_REQUEST");
    budget.admit(r1, undefined);
    const res1 = msg("codex", "RESULT");
    budget.admit(res1, r1);
    expect(budget.admit(msg("claude", "REVIEW_REQUEST"), res1)).toBeUndefined();
  });

  it("人間の入力によるターンで送った message は新しい chain になる", () => {
    const budget = new BudgetManager({ ...LIMITS, maxMessagesPerChain: 1 });
    expect(budget.admit(msg("claude", "QUESTION"), undefined)).toBeUndefined();
    expect(budget.admit(msg("claude", "QUESTION"), undefined)).toBeUndefined();
  });

  it("taskId を変えても同じ chain として数える", () => {
    const budget = new BudgetManager({ ...LIMITS, maxMessagesPerChain: 2 });
    const m1 = msg("claude", "QUESTION", { taskId: "A" });
    budget.admit(m1, undefined);
    const m2 = msg("codex", "RESULT", { taskId: "B" });
    budget.admit(m2, m1);
    expect(budget.admit(msg("claude", "QUESTION", { taskId: "C" }), m2)).toMatch(/maxMessagesPerChain/);
  });

  it("ACK は数えない", () => {
    const budget = new BudgetManager({ ...LIMITS, maxMessagesPerChain: 1 });
    const m1 = msg("claude", "QUESTION");
    budget.admit(m1, undefined);
    expect(budget.admit(msg("codex", "ACK"), m1)).toBeUndefined();
    expect(budget.admit(msg("codex", "ACK"), m1)).toBeUndefined();
  });

  it("拒否した message は数えない", () => {
    const budget = new BudgetManager({ ...LIMITS, maxMessagesPerChain: 2 });
    const m1 = msg("claude", "QUESTION");
    budget.admit(m1, undefined);
    const m2 = msg("codex", "RESULT");
    budget.admit(m2, m1);
    expect(budget.admit(msg("claude", "ISSUE"), m2)).toBeDefined();
    expect(budget.admit(msg("claude", "ISSUE"), m2)).toBeDefined();
  });

  it("エラー文は人間への報告を促す", () => {
    const budget = new BudgetManager({ ...LIMITS, maxMessagesPerChain: 0 });
    expect(budget.admit(msg("claude", "QUESTION"), undefined)).toMatch(/report .* to the human/i);
  });
});

describe("BudgetManager.closeChains", () => {
  it("閉じた chain の message を親とする送信は拒否し、新しい chain は受け付ける", () => {
    const budget = new BudgetManager(LIMITS);
    const request = msg("claude", "DELEGATE");
    expect(budget.admit(request, undefined)).toBeUndefined();
    budget.closeChains([request]);
    expect(budget.admit(msg("codex", "RESULT"), request)).toMatch(/stopped by the human/);
    expect(budget.admit(msg("claude", "DELEGATE"), undefined)).toBeUndefined();
  });
});

it("進行中の chain に上限の増減を反映する", () => {
  const budget = new BudgetManager({ ...DEFAULT_LIMITS, maxMessagesPerChain: 1 });
  const parent = msg("claude", "ISSUE");
  budget.admit(parent, undefined);
  expect(budget.admit(msg("codex", "ISSUE"), parent)).toContain("maxMessagesPerChain");
  budget.setLimits({ ...DEFAULT_LIMITS, maxMessagesPerChain: 3 });
  expect(budget.admit(msg("codex", "ISSUE"), parent)).toBeUndefined();
  budget.setLimits({ ...DEFAULT_LIMITS, maxMessagesPerChain: 1 });
  expect(budget.admit(msg("codex", "ISSUE"), parent)).toContain("maxMessagesPerChain");
});
