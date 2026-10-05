import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isUploadType, saveUpload } from "./uploads.js";

describe("saveUpload", () => {
  it("画像を時刻と乱数の名前で保存し、フルパスを返す", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "clodex-up-")), "nested");
    const path = await saveUpload(dir, "image/png", Buffer.from([1, 2]), new Date("2026-10-06T01:02:03.456Z"));
    expect(path).toMatch(/20261006T010203-[0-9a-f]{8}\.png$/);
    expect([...readFileSync(path)]).toEqual([1, 2]);
  });

  it("画像以外は受け付けない", async () => {
    expect(isUploadType("image/webp")).toBe(true);
    expect(isUploadType("text/html")).toBe(false);
    await expect(saveUpload(tmpdir(), "text/html", Buffer.from("x"))).rejects.toThrow(/unsupported/);
  });
});
