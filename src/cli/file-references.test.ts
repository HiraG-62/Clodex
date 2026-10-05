import { describe, expect, it } from "vitest";
import { appendFileReferences, extractFileReferences, resolveReferences } from "./file-references.js";

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
  it("ファイルを末尾に列挙し、無ければ本文をそのまま返す", () => {
    expect(appendFileReferences("見て", ["src/a.ts"])).toBe("見て\n\nReferenced files:\n- src/a.ts");
    expect(appendFileReferences("hello", [])).toBe("hello");
  });
});

describe("resolveReferences", () => {
  const files: Record<string, string> = { "src/a.ts": "C:/p/src/a.ts", "C:/up/shot.png": "C:/up/shot.png" };
  const resolve = async (path: string) => files[path];

  it("読めるファイルだけを末尾に並べ、画像は実パスで返す", async () => {
    await expect(resolveReferences("@src/a.ts と @C:/up/shot.png と @nope.ts", resolve)).resolves.toEqual({
      text: "@src/a.ts と @C:/up/shot.png と @nope.ts\n\nReferenced files:\n- src/a.ts\n- C:/up/shot.png",
      images: ["C:/up/shot.png"],
    });
  });
});
