import { describe, expect, it } from "vitest";
import { slashCommands } from "../../cli/commands.js";
import { createInputAssist } from "./input-assist.js";

const { suggest, highlight } = createInputAssist(slashCommands(), ["claude", "codex"], { agent: "送り先", file: "ファイル" });
const FILES = ["src/cli/input.ts", "src/web/client/input-assist.ts", "docs/DESIGN.md", "README.md"];

describe("suggest", () => {
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
