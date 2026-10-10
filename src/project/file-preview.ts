// 成果物のプレビュー用にファイルと差分を返す（DESIGN.md §28 v0.3 B）。
// 読めるのは project root と artifacts ディレクトリの中の通常ファイルだけ（実パスで確かめる）
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { inside } from "./path-scope.js";
import { safeGitArgs } from "./safe-git.js";

const ARTIFACTS_DIR = join(".clodex", "artifacts");
const UPLOADS_DIR = join(".clodex", "uploads");
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const HTTP = { badRequest: 400, notFound: 404, tooLarge: 413, unsupported: 415 } as const;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type PreviewResult = { ok: true; contentType: string; body: Buffer } | { ok: false; status: number; message: string };

export interface FilePreviewOptions {
  projectRoot: string;
  // project の外で読んでよいディレクトリ（artifacts・uploads）
  allowedDirs: readonly string[];
  maxTextBytes?: number;
  maxImageBytes?: number;
}

// 会話の履歴のファイル名（project ごとの名前とハッシュ）をそのまま使う
export const artifactsDirPath = (homeDir: string, conversationStatePath: string): string =>
  join(homeDir, ARTIFACTS_DIR, basename(conversationStatePath, extname(conversationStatePath)));

// Web UI から貼り付けた画像の保存先（DESIGN.md §28 v0.3 C）
export const uploadsDirPath = (homeDir: string, conversationStatePath: string): string =>
  join(homeDir, UPLOADS_DIR, basename(conversationStatePath, extname(conversationStatePath)));

const notFound = (path: string): PreviewResult => ({ ok: false, status: HTTP.notFound, message: `not found: ${path}` });

export const createFilePreview = ({
  projectRoot,
  allowedDirs,
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
}: FilePreviewOptions) => {
  // 実パス（symlink を解決したもの）が許可したディレクトリの中にある通常ファイルなら、その実パスを返す
  const locate = async (path: string): Promise<string | undefined> => {
    const candidate = resolve(projectRoot, path.replace(/\\/g, "/"));
    try {
      const real = await realpath(candidate);
      const roots = await Promise.all([projectRoot, ...allowedDirs].map(dir => realpath(dir).catch(() => undefined)));
      if (!roots.some(root => root && inside(root, real))) return undefined;
      return (await stat(real)).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  };

  const file = async (path: string): Promise<PreviewResult> => {
    const real = await locate(path);
    if (!real) return notFound(path);
    const imageType = IMAGE_TYPES[extname(real).toLowerCase()];
    const limit = imageType ? maxImageBytes : maxTextBytes;
    if ((await stat(real)).size > limit) return { ok: false, status: HTTP.tooLarge, message: `too large to preview: ${path}` };
    const body = await readFile(real);
    if (imageType) return { ok: true, contentType: imageType, body };
    if (body.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { ok: false, status: HTTP.unsupported, message: `binary file: ${path}` };
    }
    return { ok: true, contentType: TEXT_CONTENT_TYPE, body };
  };

  const git = (root: string, args: string[]): Promise<{ ok: boolean; output: string }> =>
    new Promise(done => {
      execFile("git", safeGitArgs(args), { cwd: root, maxBuffer: GIT_MAX_BUFFER, windowsHide: true }, (error, stdout) => done({ ok: !error, output: stdout }));
    });

  const diff = async (path: string, since?: string): Promise<PreviewResult> => {
    if (since !== undefined && (!ISO_DATE.test(since) || !Number.isFinite(Date.parse(since)))) {
      return { ok: false, status: HTTP.badRequest, message: "invalid since" };
    }
    const real = await locate(path);
    const root = await realpath(projectRoot).catch(() => projectRoot);
    if (!real || !inside(root, real)) return notFound(path);
    const filePath = relative(root, real).replace(/\\/g, "/");
    if (since !== undefined) {
      const tracked = await git(root, ["ls-files", "--error-unmatch", "--", filePath]);
      if (!tracked.ok) {
        const content = await readFile(real, "utf8");
        const lines = content.replace(/\n$/, "").split("\n");
        const output = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}\n`;
        return { ok: true, contentType: TEXT_CONTENT_TYPE, body: Buffer.from(output, "utf8") };
      }
    }
    const base = since === undefined ? "HEAD" : (await git(root, ["rev-list", "-1", `--before=${since}`, "HEAD"])).output.trim() || EMPTY_TREE;
    const result = await git(root, ["diff", base, "--", filePath]);
    return { ok: true, contentType: TEXT_CONTENT_TYPE, body: Buffer.from(result.ok ? result.output : "", "utf8") };
  };

  return { file, diff, locate };
};

export type FilePreview = ReturnType<typeof createFilePreview>;
