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

describe("formatEvent", () => {
  it.each<[string, CoordinatorEvent, string]>([
    ["session", agentEvent("claude", { type: "session", sessionId: "s-1" }), "14:32:10 [CLAUDE] session s-1"],
    ["text", agentEvent("codex", { type: "text", text: "hello" }), "14:32:10 [CODEX] hello"],
    ["tool", agentEvent("claude", { type: "tool", name: "Read", input: '{"file_path":"a.ts"}' }), '14:32:10 [CLAUDE] tool Read {"file_path":"a.ts"}'],
    ["turn", agentEvent("codex", { type: "turn", result: { status: "interrupted", text: "" } }), "14:32:10 [CODEX] turn interrupted"],
    ["exit", agentEvent("claude", { type: "exit", code: 0 }), "14:32:10 [CLAUDE] exited (code 0)"],
    ["error", agentEvent("codex", { type: "error", message: "boom" }), "14:32:10 [CODEX] ERROR boom"],
    ["rate_limit", agentEvent("claude", {
      type: "rate_limit", fiveHour: { usedPercent: 2, resetsAt: 0 }, weekly: { usedPercent: 49, resetsAt: 0 },
    }), "14:32:10 [CLAUDE] usage 5h 2% / 7d 49%"],
  ])("%s", (_, event, expected) => {
    expect(formatEvent(event)).toBe(expected);
  });

  it("message は from -> to type と task / id / replyTo を出す", () => {
    const event: CoordinatorEvent = {
      kind: "message",
      at: AT,
      message: {
        id: "msg_2", from: "codex", to: "claude", type: "RESULT", taskId: "AUTH-142", body: "x", replyTo: "msg_1",
        repository: "C:\\dev\\app", createdAt: AT,
      },
    };
    expect(formatEvent(event)).toBe("14:32:10 [MESSAGE] codex -> claude RESULT task=AUTH-142 id=msg_2 replyTo=msg_1");
  });

  it("複数行のテキストは 2 行目以降をインデントする", () => {
    expect(formatEvent(agentEvent("claude", { type: "text", text: "line1\nline2\r\nline3" })))
      .toBe("14:32:10 [CLAUDE] line1\n    line2\n    line3");
  });

  it("片方しかない rate_limit も出せる", () => {
    expect(formatEvent(agentEvent("codex", { type: "rate_limit", weekly: { usedPercent: 30, resetsAt: 0 } })))
      .toBe("14:32:10 [CODEX] usage 7d 30%");
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
