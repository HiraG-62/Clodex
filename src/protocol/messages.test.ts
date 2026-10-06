import { describe, expect, it } from "vitest";
import { MAX_BODY_LENGTH, createMessage } from "./messages.js";

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

  it("RESULT は status と issues を持てる", () => {
    const result = createMessage({
      to: "codex", type: "RESULT", taskId: "AUTH-142", body: "修正が必要", replyTo: "msg_01",
      status: "changes_requested",
      issues: [{ file: "src/auth/refresh.ts", line: 142, severity: "high", summary: "競合する" }],
    }, context);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["必須フィールドの欠落", { to: "codex", type: "QUESTION", taskId: "T-1" }, /body/],
    ["未知の type", { ...reviewRequest, type: "CHAT" }, /type/],
    ["未知の宛先", { ...reviewRequest, to: "gemini" }, /to/],
    ["自分宛て", { ...reviewRequest, to: "claude" }, /yourself/],
    ["空の taskId", { ...reviewRequest, taskId: "" }, /taskId/],
    ["長すぎる body", { ...reviewRequest, body: "x".repeat(MAX_BODY_LENGTH + 1) }, /body/],
    ["replyTo のない RESULT", { to: "codex", type: "RESULT", taskId: "T-1", body: "done" }, /replyTo/],
    ["replyTo のない ACK", { to: "codex", type: "ACK", taskId: "T-1", body: "ok" }, /replyTo/],
    ["RESULT 以外の status", { ...reviewRequest, status: "approved" }, /status/],
    ["RESULT / ISSUE 以外の issues", { ...reviewRequest, issues: [] }, /issues/],
    ["不正な severity", {
      to: "codex", type: "ISSUE", taskId: "T-1", body: "x",
      issues: [{ file: "a.ts", severity: "urgent", summary: "x" }],
    }, /severity/],
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
  it.each(["DELEGATE", "REVIEW_REQUEST"])("%s で spec を保持する", (type) => {
    expect(createMessage({ ...reviewRequest, type, spec: "docs/specs/T.md" }, context))
      .toMatchObject({ ok: true, message: { spec: "docs/specs/T.md" } });
  });
  it.each(["QUESTION", "RESULT", "ISSUE", "ACK"])("%s の spec を拒否する", (type) => {
    expect(createMessage({ ...reviewRequest, type, replyTo: "msg_x", spec: "docs/specs/T.md" }, context))
      .toMatchObject({ ok: false, error: expect.stringContaining("spec") });
  });
  it("空の spec を拒否する", () => {
    expect(createMessage({ ...reviewRequest, spec: "" }, context)).toMatchObject({ ok: false });
  });
});
