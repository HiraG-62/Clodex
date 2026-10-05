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
    ["/permission codex read-only", { kind: "permission", agent: "codex", level: "read-only" }],
  ])("%j", (line, expected) => {
    expect(parseInput(line, "claude")).toEqual(expected);
  });

  it("通常のテキストは primary Agent へ送る", () => {
    expect(parseInput("hello", "codex")).toEqual({ kind: "send", agent: "codex", text: "hello" });
  });

  it.each([
    ["@all hello", /@all/],
    ["!git status", /!command/],
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
    ["/primary gemini", /unknown agent/],
    ["/permission admin", /usage/],
    ["/permission gemini edit", /unknown agent/],
  ])("不正な入力 %j は invalid", (line, pattern) => {
    const result = parseInput(line, "claude");
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toMatch(pattern);
  });
});
