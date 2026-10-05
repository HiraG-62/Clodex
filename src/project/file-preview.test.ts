import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactsDirPath, createFilePreview } from "./file-preview.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const setup = (limits = {}) => {
  const base = mkdtempSync(join(tmpdir(), "clodex-preview-"));
  const root = join(base, "project");
  const artifacts = join(base, "artifacts");
  const outside = join(base, "outside");
  for (const dir of [root, artifacts, outside, join(root, "src")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2, 3]));
  writeFileSync(join(artifacts, "shot.png"), PNG);
  writeFileSync(join(outside, "secret.txt"), "secret");
  const preview = createFilePreview({ projectRoot: root, allowedDirs: [artifacts], ...limits });
  return { root, artifacts, outside, preview };
};

describe("artifactsDirPath", () => {
  it("~/.clodex/artifacts の下に project ごとのディレクトリを置く", () => {
    expect(artifactsDirPath("C:\\home", "C:\\home\\.clodex\\state\\E--dev-Clodex-1a2b3c4d.json"))
      .toBe(join("C:\\home", ".clodex", "artifacts", "E--dev-Clodex-1a2b3c4d"));
  });
});

describe("createFilePreview.file", () => {
  it("project のテキストを相対パスでも絶対パスでも返す", async () => {
    const { root, preview } = setup();
    for (const path of ["src/a.ts", "src\\a.ts", join(root, "src", "a.ts")]) {
      const result = await preview.file(path);
      expect(result).toMatchObject({ ok: true, contentType: "text/plain; charset=utf-8" });
      if (result.ok) expect(result.body.toString("utf8")).toBe("export const a = 1;\n");
    }
  });

  it("artifacts ディレクトリの画像を画像として返す", async () => {
    const { artifacts, preview } = setup();
    await expect(preview.file(join(artifacts, "shot.png"))).resolves.toMatchObject({ ok: true, contentType: "image/png" });
  });

  it("外のファイル・symlink で外に出るもの・無いもの・ディレクトリは返さない", async () => {
    const { root, outside, preview } = setup();
    await expect(preview.file("../outside/secret.txt")).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(preview.file(join(outside, "secret.txt"))).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(preview.file("missing.ts")).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(preview.file("src")).resolves.toMatchObject({ ok: false, status: 404 });
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    } catch {
      return; // symlink を作れない環境（権限なし）では確かめない
    }
    await expect(preview.file("link.txt")).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it("バイナリと上限を超えるファイルは返さない", async () => {
    const { preview } = setup({ maxTextBytes: 8 });
    await expect(preview.file("bin.dat")).resolves.toMatchObject({ ok: false, status: 415 });
    await expect(preview.file("src/a.ts")).resolves.toMatchObject({ ok: false, status: 413 });
  });
});

describe("createFilePreview.locate", () => {
  it("読んでよいファイルなら実パス、そうでなければ undefined", async () => {
    const { root, outside, preview } = setup();
    expect(await preview.locate("src/a.ts")).toMatch(/a\.ts$/);
    expect(await preview.locate(join(outside, "secret.txt"))).toBeUndefined();
    expect(await preview.locate(join(root, "missing"))).toBeUndefined();
  });
});

describe("createFilePreview.diff", () => {
  it("git の変更を返し、project の外は返さない", async () => {
    const { root, outside, preview } = setup();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "src/a.ts");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    const diff = await preview.diff("src/a.ts");
    expect(diff).toMatchObject({ ok: true });
    if (diff.ok) expect(diff.body.toString("utf8")).toContain("+export const a = 2;");
    await expect(preview.diff(join(outside, "secret.txt"))).resolves.toMatchObject({ ok: false, status: 404 });
  });
});
