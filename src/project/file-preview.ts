// 成果物のプレビュー用にファイルと差分を返す（DESIGN.md §28 v0.3 B）。
// 読めるのは project root と artifacts ディレクトリの中の通常ファイルだけ（実パスで確かめる）
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

const ARTIFACTS_DIR = join(".clodex", "artifacts");
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const HTTP = { notFound: 404, tooLarge: 413, unsupported: 415 } as const;

export type PreviewResult =
  | { ok: true; contentType: string; body: Buffer }
  | { ok: false; status: number; message: string };

export interface FilePreviewOptions {
  projectRoot: string;
  artifactsDir: string;
  maxTextBytes?: number;
  maxImageBytes?: number;
}

// 会話の履歴のファイル名（project ごとの名前とハッシュ）をそのまま使う
export const artifactsDirPath = (homeDir: string, conversationStatePath: string): string =>
  join(homeDir, ARTIFACTS_DIR, basename(conversationStatePath, extname(conversationStatePath)));

const notFound = (path: string): PreviewResult => ({ ok: false, status: HTTP.notFound, message: `not found: ${path}` });

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

export const createFilePreview = ({
  projectRoot, artifactsDir, maxTextBytes = DEFAULT_MAX_TEXT_BYTES, maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
}: FilePreviewOptions) => {
  // 実パス（symlink を解決したもの）が許可したディレクトリの中にある通常ファイルなら、その実パスを返す
  const locate = async (path: string): Promise<string | undefined> => {
    const candidate = resolve(projectRoot, path.replace(/\\/g, "/"));
    try {
      const real = await realpath(candidate);
      const roots = await Promise.all([projectRoot, artifactsDir].map((dir) => realpath(dir).catch(() => undefined)));
      if (!roots.some((root) => root && inside(root, real))) return undefined;
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

  // その時点の git diff HEAD。未追跡・変更なしなら空（画面は中身を出す）
  const diff = async (path: string): Promise<PreviewResult> => {
    const real = await locate(path);
    const root = await realpath(projectRoot).catch(() => projectRoot);
    if (!real || !inside(root, real)) return notFound(path);
    const output = await new Promise<string>((done) => {
      execFile("git", ["diff", "HEAD", "--", relative(root, real)], { cwd: root, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
        (error, stdout) => done(error ? "" : stdout));
    });
    return { ok: true, contentType: TEXT_CONTENT_TYPE, body: Buffer.from(output, "utf8") };
  };

  return { file, diff };
};

export type FilePreview = ReturnType<typeof createFilePreview>;
