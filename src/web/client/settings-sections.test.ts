import { expect, it } from "vitest";
import { settingsSections } from "./settings-sections.js";

it("設定を効く範囲の順に分ける", () => {
  expect(settingsSections({ mobile: false, pushSupported: true, guiConnected: true })).toEqual([
    { id: "project", items: ["rolePreset", "sandbox", "limits"] },
    { id: "device", items: ["sendKey", "push"] },
    { id: "clodex", items: ["language", "mobileConnect", "guiUpdate"] },
  ]);
});

it("スマホで送信キーを省き、Push も使えないときは端末の節を省く", () => {
  expect(settingsSections({ mobile: true, pushSupported: true, guiConnected: false })[1]).toEqual({ id: "device", items: ["push"] });
  expect(settingsSections({ mobile: true, pushSupported: false, guiConnected: false })).toEqual([
    { id: "project", items: ["rolePreset", "sandbox", "limits"] },
    { id: "clodex", items: ["language", "mobileConnect"] },
  ]);
});

it("GUI がないときも言語は残す", () => {
  expect(settingsSections({ mobile: false, pushSupported: false, guiConnected: false })[2]).toEqual({ id: "clodex", items: ["language", "mobileConnect"] });
});
