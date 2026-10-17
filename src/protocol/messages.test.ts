import { describe, expect, it } from "vitest";
import { createMessage, MAX_BODY_LENGTH } from "./messages.js";

const context = {
  from: "claude" as const,
  repository: "C:\\dev\\my-app",
  now: () => new Date("2026-10-05T07:00:00.000Z"),
  createId: () => "msg_1a2b3c4d",
};

const reviewRequest = {
  to: "codex",
  type: "REVIEW_REQUEST",
  taskId: "AUTH-142",
  body: "refresh token処理のrace conditionを確認",
  commit: "a82f39c",
  files: ["src/auth/refresh.ts"],
};

describe("createMessage", () => {
  it.each(["DELEGATE", "REVIEW_REQUEST"])("Codex 宛の %s は effort を保持する", type => {
    expect(createMessage({ ...reviewRequest, type, effort: "minimal" }, context)).toMatchObject({ ok: true, message: { effort: "minimal" } });
  });
  it.each(["FIX", "ADD", "NOTE", "CANCEL", "ANSWER", "RESULT", "QUESTION", "ISSUE", "ACK"])("%s の effort は拒否する", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "msg_original", effort: "high" }, context)).toMatchObject({
      ok: false,
      error: expect.stringContaining("effort"),
    });
  });
  it("Claude 宛と空の effort は拒否する", () => {
    expect(createMessage({ ...reviewRequest, to: "claude", effort: "high" }, { ...context, from: "codex" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("effort"),
    });
    expect(createMessage({ ...reviewRequest, effort: "" }, context).ok).toBe(false);
  });
  it.each(["DELEGATE", "FIX", "ADD"])("%s の rework を受け付ける", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "original", rework: "impl" }, context)).toMatchObject({ ok: true, message: { rework: "impl" } });
  });
  it.each(["QUESTION", "ANSWER", "RESULT", "NOTE", "CANCEL", "ACK", "ISSUE", "REVIEW_REQUEST"])("%s の rework を拒否する", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "original", rework: "spec" }, context).ok).toBe(false);
  });
  it.each(["DELEGATE", "REVIEW_REQUEST"])("%s の relatesTo を受け付ける", type => {
    expect(createMessage({ ...reviewRequest, type, relatesTo: "previous" }, context)).toMatchObject({ ok: true, message: { relatesTo: "previous" } });
  });
  it.each(["QUESTION", "ANSWER", "RESULT", "FIX", "ADD", "NOTE", "CANCEL", "ACK", "ISSUE"])("%s の relatesTo を拒否する", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "original", relatesTo: "previous" }, context).ok).toBe(false);
  });
  it.each(["ADD", "NOTE", "CANCEL"] as const)("%s は元の依頼を指定して送れる", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "msg_original" }, context)).toMatchObject({
      ok: true,
      message: { type, replyTo: "msg_original" },
    });
  });
  it.each(["FIX", "ADD", "NOTE", "CANCEL"] as const)("%s は replyTo と利用可能なフィールドを検証する", type => {
    expect(createMessage({ ...reviewRequest, type }, context).ok).toBe(false);
    for (const fields of [{ fresh: true }, { parallel: true }, { worktree: true }, { status: "done" }, { issues: [] }])
      expect(createMessage({ ...reviewRequest, type, replyTo: "msg_original", ...fields }, context).ok).toBe(false);
  });
  it.each(["ADD", "NOTE"] as const)("%s は spec を受け付ける", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "msg_original", spec: "docs/specs/T.md" }, context).ok).toBe(true);
  });
  it("CANCEL の spec は拒否し、RESULT の canceled は受け付ける", () => {
    expect(createMessage({ ...reviewRequest, type: "CANCEL", replyTo: "msg_original", spec: "docs/specs/T.md" }, context).ok).toBe(false);
    expect(createMessage({ ...reviewRequest, type: "RESULT", replyTo: "msg_original", status: "canceled" }, context)).toMatchObject({
      ok: true,
      message: { status: "canceled" },
    });
  });
  it("FIX は元の依頼と参照情報を受け付ける", () => {
    expect(createMessage({ ...reviewRequest, type: "FIX", replyTo: "msg_original", spec: "docs/specs/T.md", interrupt: true }, context)).toMatchObject({
      ok: true,
      message: { type: "FIX", replyTo: "msg_original", spec: "docs/specs/T.md", interrupt: true },
    });
  });
  it.each([{ replyTo: undefined }, { fresh: true }, { parallel: true }, { worktree: true }, { status: "done" }, { issues: [] }])(
    "FIX の不正なフィールドを拒否する: %j",
    fields => {
      expect(createMessage({ ...reviewRequest, type: "FIX", replyTo: "msg_original", ...fields }, context)).toMatchObject({ ok: false });
    },
  );
  it.each(["DELEGATE", "REVIEW_REQUEST"] as const)("%s は parallel と worktree を受け付ける", type => {
    expect(createMessage({ ...reviewRequest, type, parallel: true, worktree: true }, context)).toMatchObject({
      ok: true,
      message: { parallel: true, worktree: true },
    });
  });
  it.each(["QUESTION", "ANSWER", "RESULT", "ISSUE", "ACK"] as const)("%s の parallel を拒否する", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "msg_x", parallel: true }, context)).toMatchObject({
      ok: false,
      error: expect.stringContaining("parallel"),
    });
  });
  it.each([{ worktree: true }, { parallel: true, fresh: true }, { parallel: true, interrupt: true }])("parallel の併用条件を検証する: %j", fields => {
    expect(createMessage({ ...reviewRequest, ...fields }, context)).toMatchObject({ ok: false });
  });
  it("thread は Agent の入力から保持しない", () => {
    const result = createMessage({ ...reviewRequest, thread: "fake" }, context);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.message).not.toHaveProperty("thread");
  });
  it.each(["DELEGATE", "REVIEW_REQUEST"] as const)("%s は fresh を受け付ける", type => {
    expect(createMessage({ ...reviewRequest, type, fresh: true }, context)).toMatchObject({ ok: true, message: { fresh: true } });
  });
  it.each(["QUESTION", "ANSWER", "RESULT", "ISSUE", "ACK"] as const)("%s の fresh: true を拒否する", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "msg_x", fresh: true }, context)).toMatchObject({
      ok: false,
      error: expect.stringContaining("fresh"),
    });
  });
  it("fresh と interrupt を同時には指定できない", () => {
    expect(createMessage({ ...reviewRequest, fresh: true, interrupt: true }, context)).toMatchObject({ ok: false, error: expect.stringContaining("fresh") });
  });
  it("Agent の入力に id / from / repository / createdAt を付けて message を作る", () => {
    expect(createMessage(reviewRequest, context)).toEqual({
      ok: true,
      message: {
        ...reviewRequest,
        id: "msg_1a2b3c4d",
        from: "claude",
        repository: "C:\\dev\\my-app",
        createdAt: "2026-10-05T07:00:00.000Z",
      },
    });
  });

  it("Agent が from / id を入力に含めても Coordinator の値で上書きする", () => {
    const result = createMessage({ ...reviewRequest, from: "codex", id: "msg_fake" }, context);
    expect(result).toMatchObject({ ok: true, message: { from: "claude", id: "msg_1a2b3c4d" } });
  });
  it("Agent の入力に auto があっても保持しない", () => {
    const result = createMessage({ ...reviewRequest, auto: true }, context);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.message).not.toHaveProperty("auto");
  });

  it("RESULT は status と issues を持てる", () => {
    const result = createMessage(
      {
        to: "codex",
        type: "RESULT",
        taskId: "AUTH-142",
        body: "修正が必要",
        replyTo: "msg_01",
        status: "changes_requested",
        issues: [{ file: "src/auth/refresh.ts", line: 142, severity: "high", summary: "競合する" }],
      },
      context,
    );
    expect(result.ok).toBe(true);
  });

  it("ANSWER は replyTo と spec を持てる", () => {
    expect(createMessage({ to: "codex", type: "ANSWER", taskId: "T-1", body: "回答", replyTo: "msg_q", spec: "docs/specs/T.md" }, context)).toMatchObject({
      ok: true,
      message: { type: "ANSWER", replyTo: "msg_q", spec: "docs/specs/T.md" },
    });
  });

  it.each([
    ["必須フィールドの欠落", { to: "codex", type: "QUESTION", taskId: "T-1" }, /body/],
    ["未知の type", { ...reviewRequest, type: "CHAT" }, /type/],
    ["未知の宛先", { ...reviewRequest, to: "gemini" }, /to/],
    ["自分宛て", { ...reviewRequest, to: "claude" }, /yourself/],
    ["空の taskId", { ...reviewRequest, taskId: "" }, /taskId/],
    ["長すぎる body", { ...reviewRequest, body: "x".repeat(MAX_BODY_LENGTH + 1) }, /body/],
    ["replyTo のない RESULT", { to: "codex", type: "RESULT", taskId: "T-1", body: "done" }, /replyTo/],
    ["replyTo のない ANSWER", { to: "codex", type: "ANSWER", taskId: "T-1", body: "回答" }, /replyTo/],
    ["ANSWER の status", { to: "codex", type: "ANSWER", taskId: "T-1", body: "回答", replyTo: "msg_q", status: "done" }, /status/],
    ["ANSWER の issues", { to: "codex", type: "ANSWER", taskId: "T-1", body: "回答", replyTo: "msg_q", issues: [] }, /issues/],
    ["replyTo のない ACK", { to: "codex", type: "ACK", taskId: "T-1", body: "ok" }, /replyTo/],
    ["RESULT 以外の status", { ...reviewRequest, status: "approved" }, /status/],
    ["RESULT / ISSUE 以外の issues", { ...reviewRequest, issues: [] }, /issues/],
    [
      "不正な severity",
      {
        to: "codex",
        type: "ISSUE",
        taskId: "T-1",
        body: "x",
        issues: [{ file: "a.ts", severity: "urgent", summary: "x" }],
      },
      /severity/,
    ],
  ])("%s は拒否し、Agent が直せるエラー文を返す", (_, input, pattern) => {
    const result = createMessage(input, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(pattern);
  });

  it("既定の id は msg_ + 8 桁、createdAt は現在時刻", () => {
    const result = createMessage(reviewRequest, { from: "claude", repository: "C:\\dev\\my-app" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.id).toMatch(/^msg_[0-9a-f]{8}$/);
    expect(Number.isNaN(Date.parse(result.message.createdAt))).toBe(false);
  });
});

describe("spec の schema", () => {
  it.each(["DELEGATE", "REVIEW_REQUEST", "RESULT", "ANSWER"])("%s で spec を保持する", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "msg_x", spec: "docs/specs/T.md" }, context)).toMatchObject({
      ok: true,
      message: { spec: "docs/specs/T.md" },
    });
  });
  it.each(["QUESTION", "ISSUE", "ACK"])("%s の spec を拒否する", type => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "msg_x", spec: "docs/specs/T.md" }, context)).toMatchObject({
      ok: false,
      error: expect.stringContaining("spec"),
    });
  });
  it("空の spec を拒否する", () => {
    expect(createMessage({ ...reviewRequest, spec: "" }, context)).toMatchObject({ ok: false });
  });
});
