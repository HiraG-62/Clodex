import { describe, expect, it } from "vitest";
import { parseInput } from "./input.js";

describe("parseInput", () => {
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

  it.each([
    ["@all hello", /@all/],
    ["!& pnpm dev", /!& command/],
  ])("v0.1 未対応の入力 %j は unsupported", (line, pattern) => {
    const result = parseInput(line, "claude");
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.message).toMatch(pattern);
  });

  it.each([
    ["@claude", /empty/],
    ["@gemini hi", /unknown agent/],
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
