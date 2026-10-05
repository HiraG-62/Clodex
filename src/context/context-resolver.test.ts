import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../protocol/messages.js";
import { buildEnvelope } from "./context-resolver.js";

const base: AgentMessage = {
  id: "msg_1a2b3c4d",
  from: "claude",
  to: "codex",
  type: "REVIEW_REQUEST",
  taskId: "AUTH-142",
  body: "refresh token の race condition をレビュー",
  repository: "C:\\dev\\my-app",
  commit: "a82f39c",
  files: ["src/auth/refresh.ts"],
  createdAt: "2026-10-05T07:00:00.000Z",
};

describe("buildEnvelope", () => {
  it("依頼系は参照情報・本文・返信方法を含む", () => {
    expect(buildEnvelope(base)).toBe([
      "[Clodex] Message msg_1a2b3c4d from claude",
      "Type: REVIEW_REQUEST",
      "Task: AUTH-142",
      "Repository: C:\\dev\\my-app",
      "Commit: a82f39c",
      "Files:",
      "- src/auth/refresh.ts",
      "",
      "refresh token の race condition をレビュー",
      "",
      'Reply with the send_message tool of the "clodex" MCP server (not a shell command): to="claude", type="RESULT", taskId="AUTH-142", replyTo="msg_1a2b3c4d".',
      "Put findings in issues (file, line, severity, summary). Do not paste large content; reference files and commits.",
    ].join("\n"));
  });

  it("省略可能なフィールドが無ければその行を出さない", () => {
    const { commit: _c, files: _f, ...rest } = base;
    const envelope = buildEnvelope({ ...rest, type: "QUESTION" });
    expect(envelope).not.toContain("Commit:");
    expect(envelope).not.toContain("Files:");
    expect(envelope).toContain('type="RESULT"');
  });

  it("RESULT は status・replyTo・issues を含み、返信を求めない", () => {
    const envelope = buildEnvelope({
      ...base,
      id: "msg_5e6f7a8b",
      from: "codex",
      to: "claude",
      type: "RESULT",
      replyTo: "msg_1a2b3c4d",
      status: "changes_requested",
      body: "修正が必要",
      issues: [
        { file: "src/auth/refresh.ts", line: 142, severity: "high", summary: "同時refreshでtoken rotationが競合する" },
        { file: "src/auth/store.ts", severity: "low", summary: "命名" },
      ],
    });
    expect(envelope).toContain("Reply-To: msg_1a2b3c4d");
    expect(envelope).toContain("Status: changes_requested");
    expect(envelope).toContain("Issues:\n- [high] src/auth/refresh.ts:142 同時refreshでtoken rotationが競合する\n- [low] src/auth/store.ts 命名");
    expect(envelope).not.toContain("Reply with");
    expect(envelope).toContain("No reply is required.");
  });
});
