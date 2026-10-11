import { expect, it } from "vitest";
import { workingPanelPosition } from "./working-panel-position.js";

it("作業ログをボタンの下に置き、右端を揃え、ログの下端で止める", () => {
  expect(workingPanelPosition({ right: 1110, bottom: 45 }, { bottom: 680 }, { width: 1280, height: 800 })).toEqual({ top: 53, right: 170, bottom: 120 });
});

it("ボタンが画面の右端に近くても余白を残す", () => {
  expect(workingPanelPosition({ right: 1278, bottom: 45 }, { bottom: 780 }, { width: 1280, height: 800 })).toEqual({ top: 53, right: 12, bottom: 20 });
});
