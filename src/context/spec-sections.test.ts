import { describe, expect, it } from "vitest";
import { changedSections } from "./spec-sections.js";

const spec = ["# 認証", "", "概要", "", "## 方針", "A にする", "", "## 手順", "1. 調べる", ""].join("\n");

describe("changedSections", () => {
  it("同じ中身なら空配列", () => {
    expect(changedSections(spec, spec)).toEqual([]);
  });
  it("改行コードと行末の空白の違いは無視する", () => {
    expect(changedSections(spec, spec.replace(/\n/g, "  \r\n"))).toEqual([]);
  });
  it("中身が変わった節と追記した節を見出しのまま並べる", () => {
    const after = `${spec.replace("A にする", "B にする")}\n## 追記\nC も必要\n\n## 追記 2\nD\n`;
    expect(changedSections(spec, after)).toEqual(["## 方針", "## 追記", "## 追記 2"]);
  });
  it("消えた節には (removed) を付ける", () => {
    expect(changedSections(spec, spec.replace("## 手順\n1. 調べる\n", ""))).toEqual(["(removed) ## 手順"]);
  });
  it("最初の見出しより前は (top) とする", () => {
    expect(changedSections(spec, `前書き\n${spec}`)).toEqual(["(top)"]);
  });
  it("code fence の中の # は見出しとみなさない", () => {
    const after = spec.replace("1. 調べる", "1. 調べる\n```sh\n# コメント\n```");
    expect(changedSections(spec, after)).toEqual(["## 手順"]);
  });
  it("同じ見出しが複数あっても別の節として比べる", () => {
    const before = "## 例\na\n## 例\nb\n";
    expect(changedSections(before, "## 例\na\n## 例\nc\n")).toEqual(["## 例"]);
  });
  it("20 件を超えた分は 1 行にまとめる", () => {
    const after = Array.from({ length: 23 }, (_, i) => `## 節 ${i + 1}\n本文`).join("\n");
    const result = changedSections("", after);
    expect(result).toHaveLength(21);
    expect(result[19]).toBe("## 節 20");
    expect(result[20]).toBe("…and 3 more");
  });
});
