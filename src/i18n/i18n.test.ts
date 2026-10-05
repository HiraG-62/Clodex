import { afterEach, describe, expect, it } from "vitest";
import { format, setLanguage, t } from "./i18n.js";
import { en, ja } from "./messages.js";

afterEach(() => setLanguage("en"));

describe("i18n", () => {
  it("ja と en は同じキーを持ち、置き換える名前も同じ", () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>) expect([key, names(ja[key])]).toEqual([key, names(en[key])]);
  });

  it("言語を切り替えて params を置き換える", () => {
    expect(t("shell.primary", { agent: "codex" })).toBe("primary: codex");
    setLanguage("ja");
    expect(t("shell.deleted", { title: "x" })).toBe("削除しました: x");
  });

  it("params に無い名前はそのまま残す", () => {
    expect(format("{a} {b}", { a: 1 })).toBe("1 {b}");
  });
});
