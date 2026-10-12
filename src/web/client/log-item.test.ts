import { describe, expect, it } from "vitest";
import { splitReferenceFiles } from "./log-item.js";

describe("splitReferenceFiles", () => {
  it("3 件までは全件を表示する", () => {
    expect(splitReferenceFiles(["a", "b", "c"])).toEqual({ visible: ["a", "b", "c"], hidden: [] });
  });

  it("4 件以上は先頭の 3 件だけを表示する", () => {
    expect(splitReferenceFiles(["a", "b", "c", "d", "e"])).toEqual({ visible: ["a", "b", "c"], hidden: ["d", "e"] });
  });
});
