import { describe, expect, it } from "vitest";
import { slashCommands } from "../../cli/commands.js";
import { createInputAssist } from "./input-assist.js";

const { suggest, highlight } = createInputAssist(slashCommands(), ["claude", "codex"], {
  agent: "送り先", file: "ファイル", permission: "権限", effort: "effort", model: "model",
  conversation: "会話", project: "プロジェクト", worktree: "worktree", queued: "送信待ち",
});
const FILES = ["src/cli/input.ts", "src/web/client/input-assist.ts", "docs/DESIGN.md", "README.md"];

describe("suggest", () => {
  it("@all を候補と強調表示に含める", () => {
    expect(suggest("@a", 2, [])?.items[0]?.insert).toBe("@all ");
    expect(highlight("@all! hello", new Set())[0]).toEqual({ text: "@all!", kind: "agent" });
  });
  const state = {
    agents: [{ id: "claude", models: ["default", "opus", "sonnet", "haiku"].map((value) => ({ value, label: value === "sonnet" ? "Sonnet 5.5" : value })) }, { id: "codex", models: [{ value: "gpt-6-sol", label: "GPT-6-Sol" }] }],
    conversations: [{ title: "Planning" }, { title: "Review" }],
    projects: [{ projectRoot: "C:\\dev\\app" }],
    pendingInputs: [{ id: "in2" }],
    processes: [{ id: 1, command: "pnpm dev", status: "running" }, { id: 2, command: "pnpm test", status: "exited" }],
  };
  it("コマンドの引数を state から候補にする", () => {
    expect(suggest("/limits d", 9, FILES, state)?.items.map((i) => i.insert)).toEqual(["delegations ", "depth "]);
    expect(suggest("/model claude so", 16, FILES, state)?.items.map((i) => i.insert)).toContain("sonnet ");
    expect(suggest("/model claude so", 16, FILES, state)?.items[0]?.detail).toBe("Sonnet 5.5");
    expect(suggest("/model codex ", 13, FILES, state)?.items.map((i) => i.insert)).toContain("gpt-6-sol ");
    expect(suggest("/permission claude f", 20, FILES, state)?.items.map((i) => i.insert)).toContain("full ");
    expect(suggest("/resume ", 8, FILES, state)?.items.map((i) => i.insert)).toContain("1 ");
    expect(suggest("/project C", 10, FILES, state)?.items.map((i) => i.insert)).toContain("C:\\dev\\app ");
    expect(suggest("/project p", 10, FILES, state)?.items.map((i) => i.insert)).toEqual(["pin "]);
    expect(suggest("/project remove C", 17, FILES, state)?.items.map((i) => i.insert)).toContain("C:\\dev\\app ");
    expect(suggest("/cancel i", 9, FILES, state)?.items.map((i) => i.insert)).toContain("in2 ");
    expect(suggest("/new w", 6, FILES, state)?.items.map((i) => i.insert)).toContain("worktree ");
    expect(suggest("/processes ", 11, FILES, state)?.items.map(({ insert, detail }) => [insert, detail])).toEqual([["1 ", "pnpm dev"], ["2 ", "pnpm test"]]);
    expect(suggest("/kill ", 6, FILES, state)?.items.map(({ insert }) => insert)).toEqual(["1 "]);
  });
  it("先頭の / でコマンドの候補を出し、選ぶとコマンド名に置き換える", () => {
    const result = suggest("/mo", 3, FILES);
    expect(result).toMatchObject({ from: 0, to: 3, items: [{ label: "/model <agent> <model>", insert: "/model " }] });
  });

  it("コマンドの引数の入力中や、先頭でない / は候補を出さない", () => {
    expect(suggest("/model cl", 9, FILES)).toBeUndefined();
    expect(suggest("see /mo", 7, FILES)).toBeUndefined();
  });

  it("行頭の @ は送り先とファイル、それ以外の @ はファイルだけを候補にする", () => {
    expect(suggest("@c", 2, FILES)?.items.map((i) => i.label)).toEqual(["@claude", "@codex", "@docs/DESIGN.md", "@src/cli/input.ts", "@src/web/client/input-assist.ts"]);
    expect(suggest("見て @c", 5, FILES)?.items.map((i) => i.label)).not.toContain("@claude");
  });

  it("ファイルはファイル名の前方一致を優先する", () => {
    expect(suggest("x @inp", 6, FILES)?.items.map((i) => i.label)).toEqual(["@src/cli/input.ts", "@src/web/client/input-assist.ts"]);
  });

  it("caret の語だけを置き換える範囲を返す", () => {
    expect(suggest("a @REA b", 6, FILES)).toMatchObject({ from: 2, to: 6, items: [{ insert: "@README.md " }] });
  });
});

describe("highlight", () => {
  const files = new Set(FILES);

  it("先頭のコマンド・行頭の送り先・存在するファイルを区切る", () => {
    expect(highlight("@codex @docs/DESIGN.md を見て @nope", files)).toEqual([
      { text: "@codex", kind: "agent" },
      { text: " " },
      { text: "@docs/DESIGN.md", kind: "file" },
      { text: " を見て @nope" },
    ]);
    expect(highlight("/status now", files)).toEqual([{ text: "/status", kind: "command" }, { text: " now" }]);
    expect(highlight("@codex! now", files)[0]).toEqual({ text: "@codex!", kind: "agent" });
  });

  it("区切った文字列をつなげると元の入力に戻る", () => {
    const text = "  hello\n@codex /status @README.md。";
    expect(highlight(text, files).map((s) => s.text).join("")).toBe(text);
  });
});

it("/answer の最初の引数に未回答の質問 ID を補完する", () => {
  const state = { agents: [], conversations: [], pendingInputs: [], questions: [{ id: "q1", questions: [{ question: "方針は" }] }] };
  expect(suggest("/answer q", 9, [], state)?.items).toEqual([{ label: "q1", detail: "方針は", insert: "q1 " }]);
  expect(suggest("/answer q1 ", 11, [], state)).toBeUndefined();
});
