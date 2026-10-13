import { describe, expect, it } from "vitest";
import { restoredScrollTop, type ScrollPosition } from "./scroll-position.js";

describe("restoredScrollTop", () => {
  it("最下部を見ていたら新しい最下部へ追従する", () => {
    expect(restoredScrollTop({ kind: "bottom" }, { scrollTop: 120, scrollHeight: 900 })).toBe(900);
  });

  it("途中を読んでいたら項目の画面上の位置を保つ", () => {
    const position: ScrollPosition = { kind: "anchor", node: {} as Element, top: 200, scrollTop: 600 };
    expect(restoredScrollTop(position, { scrollTop: 600, scrollHeight: 1200, anchorTop: 260 })).toBe(660);
    expect(restoredScrollTop(position, { scrollTop: 600, scrollHeight: 1200, anchorTop: 150 })).toBe(550);
  });

  it("項目が消えたら保存した scrollTop を使う", () => {
    const position: ScrollPosition = { kind: "anchor", node: {} as Element, top: 200, scrollTop: 600 };
    expect(restoredScrollTop(position, { scrollTop: 650, scrollHeight: 1200 })).toBe(600);
  });
});
