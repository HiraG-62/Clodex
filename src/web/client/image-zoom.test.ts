import { describe, expect, it } from "vitest";
import { fitView, zoomView } from "./image-zoom.js";

describe("fitView", () => {
  it("大きい画像は枠に収まる倍率で中央に置き、小さい画像は等倍のまま中央に置く", () => {
    expect(fitView({ width: 2000, height: 1000 }, { width: 1000, height: 800 })).toEqual({ scale: 0.5, x: 0, y: 150 });
    expect(fitView({ width: 200, height: 100 }, { width: 1000, height: 800 })).toEqual({ scale: 1, x: 400, y: 350 });
  });
});

describe("zoomView", () => {
  it("指した点の下の画像の位置を動かさずに拡大する", () => {
    const view = zoomView({ scale: 1, x: 0, y: 0 }, 2, { x: 100, y: 50 });
    expect(view).toEqual({ scale: 2, x: -100, y: -50 });
  });

  it("倍率は 0.1〜8 倍に収める", () => {
    expect(zoomView({ scale: 6, x: 0, y: 0 }, 2, { x: 0, y: 0 }).scale).toBe(8);
    expect(zoomView({ scale: 0.15, x: 0, y: 0 }, 0.5, { x: 0, y: 0 }).scale).toBe(0.1);
  });
});
