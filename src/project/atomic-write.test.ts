import { mkdtempSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeFileAtomic } from "./atomic-write.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

afterEach(() => vi.mocked(renameSync).mockReset());

const busyError = () => Object.assign(new Error("rename busy"), { code: "EPERM" });

it("rename の一時的な EPERM は再試行して保存する", () => {
  const directory = mkdtempSync(join(tmpdir(), "clodex-atomic-retry-"));
  const path = join(directory, "state.json");
  vi.mocked(renameSync).mockImplementationOnce(() => { throw busyError(); });
  writeFileAtomic(path, "saved");
  expect(readFileSync(path, "utf8")).toBe("saved");
  expect(renameSync).toHaveBeenCalledTimes(2);
});

it("rename が失敗し続けたら元の例外を投げ、一時ファイルを消す", () => {
  const directory = mkdtempSync(join(tmpdir(), "clodex-atomic-fail-"));
  const path = join(directory, "state.json");
  vi.mocked(renameSync).mockImplementation(() => { throw busyError(); });
  expect(() => writeFileAtomic(path, "saved")).toThrow("rename busy");
  expect(renameSync).toHaveBeenCalledTimes(3);
  expect(readdirSync(directory)).toEqual([]);
});
