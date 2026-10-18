import { describe, expect, it } from "vitest";
import { buildRoleInstructions } from "./role-instructions.js";

describe("buildRoleInstructions", () => {
  it("再依頼では同じ taskId と rework を使う", () => {
    expect(buildRoleInstructions("codex", undefined)).toContain(
      "To request rework of a task, send it with the same taskId and set rework (spec, impl or check); do not create a new taskId.",
    );
  });
  it("rules を役割の行の直後に複数行のまま挿入する", () => {
    const text = buildRoleInstructions("codex", { codex: "実装" }, { rules: "テスト\n型チェック" });
    expect(text).toContain("Small edits (typos, formatting, trivial fixes) you may do yourself.\nRules: テスト\n型チェック\nThe human");
    expect(buildRoleInstructions("codex", undefined, { rules: "テスト" })).toContain("Rules: テスト");
    expect(buildRoleInstructions("codex", undefined, { rules: "" })).not.toContain("Rules:");
    expect(buildRoleInstructions("codex", undefined, { rules: "テスト", brainstorm: true })).not.toContain("Rules:");
  });
  it("ブレストでは役割の指示を外して読み取り専用の定型文にする", () => {
    const text = buildRoleInstructions("codex", { codex: "実装", claude: "設計" }, { brainstorm: true, language: "ja" });
    expect(text).toContain("brainstorming together");
    expect(text).toContain("do not edit files");
    expect(text).toContain("Do not use send_message or ask_user");
    expect(text).not.toContain("Your role:");
  });
  it("自分と相手の役割と、相手の役割の作業は send_message で依頼することを伝える", () => {
    const text = buildRoleInstructions("claude", { claude: "設計とレビュー", codex: "実装" });
    expect(text).toContain('You are the "claude" agent in Clodex');
    expect(text).toContain('peer agent "codex"');
    expect(text).toContain("Your role: 設計とレビュー");
    expect(text).toContain("Role of codex: 実装");
    expect(text).toMatch(/send_message tool of the "clodex" MCP server/);
    expect(text).toMatch(/Do not do the same work/);
  });

  it("相手から見た文面は立場が入れ替わる", () => {
    const text = buildRoleInstructions("codex", { claude: "設計", codex: "実装" });
    expect(text).toContain('You are the "codex" agent');
    expect(text).toContain("Your role: 実装");
    expect(text).toContain("Role of claude: 設計");
  });

  it("片方だけ役割があれば、無い方は not specified", () => {
    const text = buildRoleInstructions("codex", { claude: "設計" });
    expect(text).toContain("Your role: not specified");
    expect(text).toContain("Role of claude: 設計");
  });

  it("空文字の役割は未設定として扱う", () => {
    expect(buildRoleInstructions("claude", { claude: "", codex: "" })).not.toContain("Your role:");
    const text = buildRoleInstructions("codex", { claude: "設計", codex: "" });
    expect(text).toContain("Your role: not specified");
  });

  it("役割の有無にかかわらず /permission を案内するよう伝える", () => {
    expect(buildRoleInstructions("claude", undefined)).toContain("/permission");
    expect(buildRoleInstructions("codex", { claude: "設計" })).toContain("/permission");
  });

  it("役割が無ければ相手の Agent がいることだけを伝える", () => {
    const text = buildRoleInstructions("claude", undefined);
    expect(text).toContain('peer agent "codex"');
    expect(text).not.toContain("Your role");
    expect(text).toMatch(/only when an independent view/);
  });
});

describe("buildRoleInstructions の方針と言語", () => {
  it("作業前に方針を書くよう伝え、言語の指定があれば添える", () => {
    expect(buildRoleInstructions("claude", undefined)).toMatch(/before you start working/);
    expect(buildRoleInstructions("claude", undefined)).not.toContain("Japanese");
    expect(buildRoleInstructions("codex", undefined, { language: "ja" })).toContain("Japanese");
  });

  it("artifacts ディレクトリがあれば証跡の画像の置き場所を伝える", () => {
    const text = buildRoleInstructions("claude", undefined, { artifactsDir: "C:\\home\\.clodex\\artifacts\\p" });
    expect(text).toContain("save it under C:\\home\\.clodex\\artifacts\\p");
    expect(text).toContain("[name](<full path>)");
    expect(text).toContain("It appears under Shared.");
    expect(text).toContain("final reply or in an ask_user question");
    expect(text).toContain("plain path or as a Markdown link [name](<full path>)");
    expect(text).toContain("Paths in intermediate progress notes are not shown.");
  });
});

describe("buildRoleInstructions の割り込みと subagent", () => {
  it("interrupt の使いどころと subagent の使いどころを伝える", () => {
    const text = buildRoleInstructions("codex", undefined);
    expect(text).toMatch(/FIX/);
    expect(text).toMatch(/ADD/);
    expect(text).toMatch(/NOTE/);
    expect(text).toMatch(/CANCEL/);
    expect(text).toMatch(/replyTo/);
    expect(text).toMatch(/DELEGATE/);
    expect(text).toMatch(/sub-agents/);
  });
});

it("役割あり・なしで設計書を先に書いて spec に指定する方針を伝える", () => {
  for (const roles of [undefined, { claude: "設計", codex: "実装" }]) {
    const text = buildRoleInstructions("codex", roles);
    expect(text).toContain("DELEGATE / REVIEW_REQUEST");
    expect(text).toContain("docs/specs/<taskId>.md");
    expect(text).toContain("spec");
    expect(text).toMatch(/body.*summary/);
    expect(text).toContain("a few lines");
    expect(text).toContain("set spec on the ANSWER");
    expect(text).toContain("Use RESULT when delegated work is complete");
    expect(text).toContain("generation commands (build, codegen, dictionary updates)");
    expect(text).toContain("Updating files rewritten by generation commands is allowed by default.");
  }
});

it("send_message の body の書式を伝える", () => {
  expect(buildRoleInstructions("codex", undefined)).toContain("Write body in Markdown");
});

it.each(["claude", "codex"] as const)("%s に QUESTION・設計書・RESULT の作法を伝え、ブレストでは省く", agent => {
  const instructions = [
    'Write a QUESTION body in three lines: "Decide:" (what you need decided), "Blocked:" (work waiting for the answer), "Continuing:" (work you continue meanwhile). Stop work that depends on the answer.',
    'Split the spec into "Fixed" (behavior, invariants, public interfaces, files that may be edited) and "Discretion" (what the implementer may decide). Before doing anything against a Fixed section, ask with a QUESTION.',
    "After sending RESULT with send_message, keep your final reply to one line.",
  ];
  for (const roles of [undefined, { claude: "設計", codex: "実装" }]) {
    const text = buildRoleInstructions(agent, roles, { rules: "テスト" });
    const brainstorm = buildRoleInstructions(agent, roles, { brainstorm: true });
    for (const instruction of instructions) {
      expect(text).toContain(instruction);
      expect(text.indexOf(instruction)).toBeGreaterThan(text.indexOf("Rules: テスト"));
      expect(brainstorm).not.toContain(instruction);
    }
  }
});

it.each(["claude", "codex"] as const)("%s の usageHints が ON のときだけ再読・再検証を避ける指示を足す", agent => {
  const instruction = "Do not re-read content you already read. Do not rerun the same tests or type checks when nothing has changed.";
  expect(buildRoleInstructions(agent, undefined, { usageHints: true })).toContain(instruction);
  expect(buildRoleInstructions(agent, undefined)).not.toContain(instruction);
  expect(buildRoleInstructions(agent, undefined, { usageHints: false })).not.toContain(instruction);
  expect(buildRoleInstructions(agent, undefined, { usageHints: true, brainstorm: true })).not.toContain(instruction);
});

it("fresh の使い方は両 Agent に、使用量の作法は設定で有効にした Agent にだけ伝える", () => {
  const claude = buildRoleInstructions("claude", undefined);
  const codex = buildRoleInstructions("codex", undefined);
  for (const instruction of [claude, codex]) {
    expect(instruction).toContain("fresh: true");
    expect(instruction).toContain("earlier context");
  }
  expect(codex).not.toContain("yield_time_ms");
  expect(claude).not.toContain("yield_time_ms");
  const codexOn = buildRoleInstructions("codex", undefined, { usageHints: true });
  expect(codexOn).toContain("yield_time_ms");
  expect(codexOn).toContain("Do not poll in small steps");
  expect(codexOn).toContain("Read the relevant range of a file at once");
  expect(codexOn).not.toContain("run_in_background");
  const claudeOn = buildRoleInstructions("claude", undefined, { usageHints: true });
  expect(claudeOn).toContain("Bash timeout");
  expect(claudeOn).toContain("run_in_background");
  expect(claudeOn).not.toContain("yield_time_ms");
});

it.each(["claude", "codex"] as const)("%s に人への質問は ask_user を使いターンを終えるよう指示する", agent => {
  expect(buildRoleInstructions(agent, undefined)).toContain(
    'When you need a decision from the human, ask with the ask_user tool of the "clodex" MCP server instead of writing the question in your reply, then end your turn.',
  );
});

it.each(["claude", "codex"] as const)("%s に同じ会話の本文を読む方法を伝える", agent => {
  expect(buildRoleInstructions(agent, undefined)).toContain('Use the read_conversation tool of the "clodex" MCP server');
});
it("検証プロファイルは定型文に一度だけ入り、ブレストには入らない", () => {
  const verify = { implement: ["pnpm test", "pnpm typecheck"], integrate: ["pnpm lint"] };
  const line =
    "Default checks: implement = pnpm test; pnpm typecheck; integrate = pnpm lint. Run the default checks for your step plus any checks the spec adds.";
  expect(buildRoleInstructions("codex", undefined, { verify })).toContain(line);
  expect(buildRoleInstructions("codex", undefined, { verify, brainstorm: true })).not.toContain("Default checks:");
  expect(buildRoleInstructions("claude", undefined, { verify: { integrate: ["pnpm lint"] } })).toContain("Default checks: integrate = pnpm lint.");
});
