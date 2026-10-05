import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CoordinatorEvent } from "../coordinator/event-bus.js";
import { createJsonlWriter, defaultLogPath, formatEvent } from "./event-log.js";

// ローカル時刻 14:32:10 の ISO 文字列（タイムゾーンに依存しないテストにする）
const AT = new Date(2026, 9, 5, 14, 32, 10).toISOString();

const agentEvent = (agent: "claude" | "codex", event: Extract<CoordinatorEvent, { kind: "agent" }>["event"]): CoordinatorEvent =>
  ({ kind: "agent", agent, event, at: AT });

const message = (body: string): CoordinatorEvent => ({
  kind: "message",
  at: AT,
  message: {
    id: "msg_2", from: "codex", to: "claude", type: "RESULT", taskId: "AUTH-142", body, replyTo: "msg_1",
    repository: "C:\\dev\\app", createdAt: AT,
  },
});

describe("formatEvent（verbose）", () => {
  it.each<[string, CoordinatorEvent, string]>([
    ["session", agentEvent("claude", { type: "session", sessionId: "s-1" }), "14:32:10 [CLAUDE] session s-1"],
    ["text", agentEvent("codex", { type: "text", text: "hello" }), "14:32:10 [CODEX] hello"],
    ["tool", agentEvent("claude", { type: "tool", name: "Read", input: '{"file_path":"a.ts"}' }), '14:32:10 [CLAUDE] tool Read {"file_path":"a.ts"}'],
    ["turn_started", agentEvent("codex", { type: "turn_started" }), "14:32:10 [CODEX] working..."],
    ["turn", agentEvent("codex", { type: "turn", result: { status: "interrupted", text: "" } }), "14:32:10 [CODEX] turn interrupted"],
    ["exit", agentEvent("claude", { type: "exit", code: 0 }), "14:32:10 [CLAUDE] exited (code 0)"],
    ["error", agentEvent("codex", { type: "error", message: "boom" }), "14:32:10 [CODEX] ERROR boom"],
    ["rate_limit", agentEvent("claude", {
      type: "rate_limit", fiveHour: { usedPercent: 2, resetsAt: 0 }, weekly: { usedPercent: 49, resetsAt: 0 },
    }), "14:32:10 [CLAUDE] usage 5h 2% / 7d 49%"],
    ["human", { kind: "human", agent: "codex", text: "review this", at: AT }, "14:32:10 [YOU -> CODEX] review this"],
    ["notice", { kind: "notice", text: "codex 5h usage is 91%.", at: AT }, "14:32:10 [CLODEX] codex 5h usage is 91%."],
  ])("%s", (_, event, expected) => {
    expect(formatEvent(event, "verbose")).toBe(expected);
  });

  it("message は from -> to type と task / id / replyTo を出す", () => {
    expect(formatEvent(message("x"), "verbose")).toBe("14:32:10 [MESSAGE] codex -> claude RESULT task=AUTH-142 id=msg_2 replyTo=msg_1");
  });

  it("複数行のテキストは 2 行目以降をインデントする", () => {
    expect(formatEvent(agentEvent("claude", { type: "text", text: "line1\nline2\r\nline3" }), "verbose"))
      .toBe("14:32:10 [CLAUDE] line1\n    line2\n    line3");
  });

  it("片方しかない rate_limit も出せる", () => {
    expect(formatEvent(agentEvent("codex", { type: "rate_limit", weekly: { usedPercent: 30, resetsAt: 0 } }), "verbose"))
      .toBe("14:32:10 [CODEX] usage 7d 30%");
  });
});

describe("formatEvent（既定）", () => {
  it.each<[string, CoordinatorEvent, string]>([
    ["turn_started", agentEvent("claude", { type: "turn_started" }), "14:32:10 [CLAUDE] working..."],
    ["完了したターンは最終応答", agentEvent("claude", { type: "turn", result: { status: "completed", text: "PONG" } }), "14:32:10 [CLAUDE] PONG"],
    ["最終応答が空なら done", agentEvent("codex", { type: "turn", result: { status: "completed", text: "" } }), "14:32:10 [CODEX] done"],
    ["interrupted", agentEvent("codex", { type: "turn", result: { status: "interrupted", text: "" } }), "14:32:10 [CODEX] interrupted"],
    ["failed", agentEvent("claude", { type: "turn", result: { status: "failed", text: "boom" } }), "14:32:10 [CLAUDE] failed: boom"],
    ["error", agentEvent("codex", { type: "error", message: "boom" }), "14:32:10 [CODEX] ERROR boom"],
    ["notice", { kind: "notice", text: "hi", at: AT }, "14:32:10 [CLODEX] hi"],
  ])("%s", (_, event, expected) => {
    expect(formatEvent(event, "normal")).toBe(expected);
  });

  it("最終応答が複数行なら 2 行目以降をインデントする", () => {
    expect(formatEvent(agentEvent("claude", { type: "turn", result: { status: "completed", text: "a\nb" } }), "normal"))
      .toBe("14:32:10 [CLAUDE] a\n    b");
  });

  it("message は誰が誰に何を頼んだかと本文の先頭 1 行を出す", () => {
    expect(formatEvent(message("修正が必要\n詳細..."), "normal"))
      .toBe('14:32:10 [MESSAGE] codex -> claude RESULT task=AUTH-142 "修正が必要"');
  });

  it("長い本文は切り詰める", () => {
    const line = formatEvent(message("x".repeat(200)), "normal")!;
    expect(line).toContain(`"${"x".repeat(80)}..."`);
  });

  it.each<[string, CoordinatorEvent]>([
    ["text", agentEvent("claude", { type: "text", text: "途中の発言" })],
    ["tool", agentEvent("claude", { type: "tool", name: "Bash", input: "ls" })],
    ["rate_limit", agentEvent("claude", { type: "rate_limit", weekly: { usedPercent: 1, resetsAt: 0 } })],
    ["session", agentEvent("codex", { type: "session", sessionId: "s" })],
    ["exit", agentEvent("codex", { type: "exit", code: null })],
    ["human", { kind: "human", agent: "claude", text: "hi", at: AT }],
  ])("%s は表示しない", (_, event) => {
    expect(formatEvent(event, "normal")).toBeUndefined();
  });
});

describe("createJsonlWriter", () => {
  it("event を 1 行 1 JSON で追記し、ディレクトリが無ければ作る", () => {
    const path = join(mkdtempSync(join(tmpdir(), "clodex-log-")), "nested", "log.jsonl");
    const write = createJsonlWriter(path);
    const e1 = agentEvent("claude", { type: "text", text: "a" });
    const e2 = agentEvent("codex", { type: "exit", code: 1 });
    write(e1);
    write(e2);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([e1, e2]);
  });
});

describe("defaultLogPath", () => {
  it("ホームの .clodex/logs に project 名と起動時刻で置く", () => {
    const path = defaultLogPath("C:\\dev\\my-app", new Date(2026, 9, 5, 14, 32, 10));
    expect(path).toBe(join(homedir(), ".clodex", "logs", "my-app-20261005-143210.jsonl"));
  });
});
