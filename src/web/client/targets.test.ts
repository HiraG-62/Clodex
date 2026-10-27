import { describe, expect, it } from "vitest";
import { readTarget, saveTarget, staleTargetKeys, targetKey } from "./targets.js";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => values.set(key, value),
    remove: (key: string) => values.delete(key),
  };
}

describe("会話ごとの送り先", () => {
  it("会話とプロジェクトごとに保存し、切り替え後も復元する", () => {
    const saved = storage();
    const a = targetKey("C:/work", "a");
    const b = targetKey("C:/work", "b");
    saveTarget(saved, a, "codex");
    saveTarget(saved, b, "gemini");
    expect(readTarget(saved, b)).toBe("gemini");
    expect(readTarget(saved, a)).toBe("codex");
    expect(readTarget(saved, targetKey("C:/other", "a"))).toBeUndefined();
    expect(readTarget({ ...saved }, a)).toBe("codex");
    expect(targetKey("C:/work:a", "b")).not.toBe(targetKey("C:/work", "a:b"));
  });

  it("値なしは primary に戻し、不正値は削除する", () => {
    const saved = storage();
    const key = targetKey("C:/work", "a");
    expect(readTarget(saved, key) ?? "claude").toBe("claude");
    saved.values.set(key, "unknown");
    expect(readTarget(saved, key) ?? "codex").toBe("codex");
    expect(saved.values.has(key)).toBe(false);
  });

  it("solo 固定を優先し、固定中は保存値を上書きしない", () => {
    const saved = storage();
    const key = targetKey("C:/work", "a");
    saveTarget(saved, key, "codex");
    expect(readTarget(saved, key, "claude")).toBe("claude");
    saveTarget(saved, key, "claude", "claude");
    expect(saved.values.get(key)).toBe("codex");
    expect(readTarget(saved, key, "free")).toBe("codex");
  });

  it("削除済み会話の鍵だけを掃除する", () => {
    const active = targetKey("C:/work", "a");
    const deleted = targetKey("C:/work", "b");
    const other = targetKey("C:/other", "b");
    expect(staleTargetKeys([active, deleted, other, "clodex-theme"], "C:/work", ["a"])).toEqual([deleted]);
    expect(staleTargetKeys([active, other], "C:/work", [])).toEqual([active]);
  });
});
