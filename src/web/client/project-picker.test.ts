import { describe, expect, it, vi } from "vitest";
import { chooseProjectPath } from "./project-picker.js";

describe("chooseProjectPath", () => {
  it("Tauri ではネイティブのフォルダ選択を使う", async () => {
    const prompt = vi.fn(() => "browser-path");
    expect(await chooseProjectPath(async () => "C:\\dev\\app", prompt)).toBe("C:\\dev\\app");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("ブラウザでは prompt を使い、キャンセルは送らない", async () => {
    expect(await chooseProjectPath(undefined, () => " ./app ")).toBe("./app");
    expect(await chooseProjectPath(undefined, () => null)).toBeUndefined();
    expect(
      await chooseProjectPath(
        async () => null,
        () => "browser-path",
      ),
    ).toBeUndefined();
  });
});
