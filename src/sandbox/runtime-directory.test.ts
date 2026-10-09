import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { prepareRuntimeDirectory, removeRuntimeDirectory } from "./runtime-directory.js";

it("SID の ACL 修復後は古い cache を除去し、再実行では現在の cache を残す", async () => {
  const temp = await mkdtemp(join(tmpdir(), "clodex-runtime-"));
  const root = join(temp, "Clodex-Sandbox-human");
  await mkdir(join(root, "old"), { recursive: true });
  await writeFile(join(root, "old", "node.exe"), "fixture");
  const host = vi.fn(async (_script: string) => "true");
  await prepareRuntimeDirectory(root, "human", "new-agent", host);
  expect(await readdir(root)).toEqual([]);
  expect(host.mock.calls[0]?.[0]).toContain("new-agent");
  await writeFile(join(root, "current"), "fixture");
  host.mockResolvedValue("false");
  await prepareRuntimeDirectory(root, "human", "new-agent", host);
  expect(await readdir(root)).toEqual(["current"]);
  await removeRuntimeDirectory(root, "human", host);
  expect(await readdir(temp)).toEqual([]);
});

it("runtime 内のリンクをたどらず、所有者検査の失敗でも削除しない", async () => {
  const temp = await mkdtemp(join(tmpdir(), "clodex-runtime-link-"));
  const root = join(temp, "Clodex-Sandbox-human"),
    outside = join(temp, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "fixture");
  await symlink(outside, join(root, "link"), "junction");
  await expect(
    removeRuntimeDirectory(
      root,
      "human",
      vi.fn(async () => ""),
    ),
  ).rejects.toThrow();
  expect(await readdir(outside)).toEqual(["keep"]);
  await expect(
    removeRuntimeDirectory(
      outside,
      "human",
      vi.fn(async () => ""),
    ),
  ).rejects.toThrow();
  const owned = join(temp, "Clodex-Sandbox-other");
  await mkdir(owned);
  await writeFile(join(owned, "keep"), "fixture");
  await expect(
    removeRuntimeDirectory(
      owned,
      "other",
      vi.fn(async () => {
        throw new Error("owner");
      }),
    ),
  ).rejects.toThrow("owner");
  expect(await readdir(owned)).toEqual(["keep"]);
});
