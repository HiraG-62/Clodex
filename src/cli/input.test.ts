import { describe, expect, it } from "vitest";
import { parseInput } from "./input.js";

describe("parseInput", () => {
  it("/role の表示と編集を区別する", () => {
    expect(parseInput("/role", "claude")).toEqual({ kind: "role" });
    expect(parseInput("/role codex", "claude")).toEqual({ kind: "role", agent: "codex" });
    expect(parseInput("/role codex 実装を担当", "claude")).toEqual({ kind: "role", agent: "codex", text: "実装を担当" });
  });
  it("/project を一覧とパス指定に解釈する", () => {
    expect(parseInput("/project", "claude")).toEqual({ kind: "project" });
    expect(parseInput("/project C:\\dev\\app", "claude")).toEqual({ kind: "project", path: "C:\\dev\\app" });
  });
  it.each([
    ["", { kind: "empty" }],
    ["   ", { kind: "empty" }],
    ["fix the bug", { kind: "send", agent: "claude", text: "fix the bug" }],
    ["  fix the bug  ", { kind: "send", agent: "claude", text: "fix the bug" }],
    ["@codex review this", { kind: "send", agent: "codex", text: "review this" }],
    ["@claude 日本語の依頼", { kind: "send", agent: "claude", text: "日本語の依頼" }],
    ["/interrupt", { kind: "interrupt" }],
    ["/interrupt codex", { kind: "interrupt", agent: "codex" }],
    ["/status", { kind: "status" }],
    ["/help", { kind: "help" }],
    ["/exit", { kind: "exit" }],
    ["/verbose", { kind: "verbose" }],
    ["/permission full", { kind: "permission", level: "full" }],
    ["/primary codex", { kind: "primary", agent: "codex" }],
    ["/resume", { kind: "resume" }],
    ["/new", { kind: "new" }],
    ["/compact", { kind: "compact" }],
    ["/compact claude", { kind: "compact", agent: "claude" }],
    ["/new codex", { kind: "new", agent: "codex" }],
    ["/resume 3", { kind: "resume", index: 3 }],
    ["/permission codex read-only", { kind: "permission", agent: "codex", level: "read-only" }],
    ["/model claude haiku", { kind: "model", agent: "claude", model: "haiku" }],
    ["/model codex gpt-6-sol", { kind: "model", agent: "codex", model: "gpt-6-sol" }],
    ["/effort high", { kind: "effort", level: "high" }],
    ["/effort claude max", { kind: "effort", agent: "claude", level: "max" }],
    ["/effort codex minimal", { kind: "effort", agent: "codex", level: "minimal" }],
  ])("%j", (line, expected) => {
    expect(parseInput(line, "claude")).toEqual(expected);
  });

  it("!command は shell command として実行する", () => {
    expect(parseInput("!git status", "claude")).toEqual({ kind: "run", command: "git status" });
    expect(parseInput("!  pnpm test ", "claude")).toEqual({ kind: "run", command: "pnpm test" });
    expect(parseInput("!", "claude")).toMatchObject({ kind: "invalid", message: expect.stringMatching(/usage/) });
  });

  it("通常のテキストは primary Agent へ送る", () => {
    expect(parseInput("hello", "codex")).toEqual({ kind: "send", agent: "codex", text: "hello" });
  });

  it("/rename・/delete・/pin を解釈する", () => {
    expect(parseInput("/rename 新しい 名前", "claude")).toEqual({ kind: "rename", title: "新しい 名前" });
    expect(parseInput("/delete 2", "claude")).toEqual({ kind: "delete", index: 2 });
    expect(parseInput("/pin 1", "claude")).toEqual({ kind: "pin", index: 1 });
    for (const line of ["/rename", "/delete", "/delete x", "/pin 0"]) expect(parseInput(line, "claude").kind).toBe("invalid");
  });

  it("/cancel は ID を省略できる", () => {
    expect(parseInput("/cancel", "claude")).toEqual({ kind: "cancel" });
    expect(parseInput("/cancel in3", "claude")).toEqual({ kind: "cancel", id: "in3" });
    expect(parseInput("/cancel a b", "claude").kind).toBe("invalid");
  });

  it("行頭の @ が Agent でなければファイルの参照として primary に送る", () => {
    expect(parseInput("@src/a.ts を見て", "codex")).toEqual({ kind: "send", agent: "codex", text: "@src/a.ts を見て" });
  });

  it("スラッシュコマンドの 2 行目以降は invalid", () => {
    for (const input of ["/status\nhello", "/model claude haiku\r\nnext", "/help\n", "/unknown\nnext"]) {
      expect(parseInput(input, "claude").kind).toBe("invalid");
    }
    expect(parseInput("@claude first\nsecond", "claude")).toEqual({ kind: "send", agent: "claude", text: "first\nsecond" });
  });

  it("/limits unlimited を解釈する", () => {
    expect(parseInput("/limits unlimited", "claude")).toEqual({ kind: "limits", unlimited: true });
  });

  it("/solo を解釈する", () => {
    expect(parseInput("/solo", "claude")).toEqual({ kind: "solo", mode: "free" });
    expect(parseInput("/solo enable", "claude")).toEqual({ kind: "solo", mode: "free" });
    expect(parseInput("/solo codex", "claude")).toEqual({ kind: "solo", mode: "codex" });
    expect(parseInput("/solo disable", "claude")).toEqual({ kind: "solo" });
    expect(parseInput("/solo x", "claude").kind).toBe("invalid");
  });

  it("!> は結果を Agent に渡す実行にし、@agent で渡し先を選ぶ", () => {
    expect(parseInput("!> pnpm test", "claude")).toEqual({ kind: "runAndSend", command: "pnpm test" });
    expect(parseInput("@codex !> pnpm test", "claude")).toEqual({ kind: "runAndSend", command: "pnpm test", agent: "codex" });
    expect(parseInput("!>", "claude").kind).toBe("invalid");
    expect(parseInput("@codex !>", "claude").kind).toBe("invalid");
  });

  it("background process の操作を解釈する", () => {
    expect(parseInput("!& pnpm dev", "claude")).toEqual({ kind: "background", command: "pnpm dev" });
    expect(parseInput("/processes", "claude")).toEqual({ kind: "processes" });
    expect(parseInput("/processes 2", "claude")).toEqual({ kind: "processes", id: 2 });
    expect(parseInput("/kill 1", "claude")).toEqual({ kind: "kill", id: 1 });
    for (const line of ["!&", "/kill", "/kill 0", "/kill 1 2", "/processes x"]) {
      expect(parseInput(line, "claude").kind).toBe("invalid");
    }
  });

  it.each([
    ["@all", /empty/],
    ["@all!", /empty/],
    ["@claude", /empty/],
    ["/interrupt gemini", /unknown agent/],
    ["/foo", /unknown command/],
    ["/permission", /usage/],
    ["/primary", /usage/],
    ["/resume 0", /usage/],
    ["/new gemini", /unknown agent/],
    ["/compact gemini", /unknown agent/],
    ["/resume x", /usage/],
    ["/primary gemini", /unknown agent/],
    ["/permission admin", /usage/],
    ["/permission gemini edit", /unknown agent/],
    ["/model", /usage/],
    ["/model haiku", /usage/],
    ["/model gemini x", /unknown agent/],
    ["/effort", /usage/],
    ["/effort max", /usage/],
    ["/effort claude minimal", /usage/],
    ["/effort codex", /usage/],
  ])("不正な入力 %j は invalid", (line, pattern) => {
    const result = parseInput(line, "claude");
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toMatch(pattern);
  });
});

describe("@agent! で割り込む", () => {
  it("@all と @all! は両 Agent を対象にする", () => {
    expect(parseInput("@all hello", "claude")).toEqual({ kind: "sendAll", text: "hello" });
    expect(parseInput("@all! hello", "claude")).toEqual({ kind: "sendAll", text: "hello", steer: true });
  });
  it("送り先の後ろの ! は steer の指定", () => {
    expect(parseInput("@codex! テストは不要", "claude")).toEqual({ kind: "send", agent: "codex", text: "テストは不要", steer: true });
    expect(parseInput("@claude 普通", "codex")).toEqual({ kind: "send", agent: "claude", text: "普通" });
  });
});

describe("/new worktree", () => {
  it("新しい会話を worktree で始める指定", () => {
    expect(parseInput("/new worktree", "claude")).toEqual({ kind: "new", worktree: true });
    expect(parseInput("/new codex", "claude")).toEqual({ kind: "new", agent: "codex" });
  });
});

it("/answer の ID と回答本文を分離する", () => {
  expect(parseInput('/answer q1 [["A", "B"]]', "claude")).toEqual({ kind: "answer", id: "q1", text: '[["A", "B"]]' });
  expect(parseInput("/answer q1 自由な回答", "claude")).toEqual({ kind: "answer", id: "q1", text: "自由な回答" });
  for (const line of ["/answer", "/answer q1"]) expect(parseInput(line, "claude").kind).toBe("invalid");
});

it("/limits の表示・変更・リセットと範囲を検証する", () => {
  expect(parseInput("/limits", "claude")).toEqual({ kind: "limits" });
  expect(parseInput("/limits reset", "claude")).toEqual({ kind: "limits", reset: true });
  expect(parseInput("/limits messages 16", "claude")).toEqual({ kind: "limits", name: "messages", value: 16 });
  for (const arg of ["messages 0", "messages 101", "messages 1.5", "messages x", "unknown 2", "reset extra", "messages 2 extra"]) {
    expect(parseInput(`/limits ${arg}`, "claude").kind).toBe("invalid");
  }
});
