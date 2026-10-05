import { describe, expect, it } from "vitest";
import { appendFileReferences, extractFileReferences } from "./file-references.js";

describe("extractFileReferences", () => {
  it("空白の後の @path を取り出し、重複を除く", () => {
    expect(extractFileReferences("@src/a.ts と @docs/DESIGN.md を見て。@src/a.ts も")).toEqual(["src/a.ts", "docs/DESIGN.md"]);
  });

  it("文末の句読点や括弧はパスに含めない", () => {
    expect(extractFileReferences("(see @src/a.ts). 次に @README.md。")).toEqual(["src/a.ts", "README.md"]);
  });

  it("メールアドレスのような語中の @ は対象外", () => {
    expect(extractFileReferences("mail me at a@example.com")).toEqual([]);
  });

  it("Windows の区切り文字は / にそろえる", () => {
    expect(extractFileReferences("@src\\cli\\input.ts")).toEqual(["src/cli/input.ts"]);
  });
});

describe("appendFileReferences", () => {
  const exists = (path: string) => ["src/a.ts", "README.md"].includes(path);

  it("存在するファイルだけを末尾に列挙する", () => {
    expect(appendFileReferences("@src/a.ts と @codex と @nope.ts", exists))
      .toBe("@src/a.ts と @codex と @nope.ts\n\nReferenced files:\n- src/a.ts");
  });

  it("参照が無ければ本文をそのまま返す", () => {
    expect(appendFileReferences("hello @nope", exists)).toBe("hello @nope");
  });
});
