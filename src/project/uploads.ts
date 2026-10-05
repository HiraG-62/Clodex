// Web UI から貼り付けた画像を保存する（DESIGN.md §28 v0.3 C）
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const NAME_RANDOM_BYTES = 4;
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
};

export const isUploadType = (contentType: string): boolean => contentType in EXTENSIONS;

// 保存したファイルのフルパスを返す。名前は時刻と乱数（元の名前は使わない）
export const saveUpload = async (dir: string, contentType: string, body: Buffer, now: Date = new Date()): Promise<string> => {
  const extension = EXTENSIONS[contentType];
  if (!extension) throw new Error(`unsupported upload type: ${contentType}`);
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const path = join(dir, `${stamp}-${randomBytes(NAME_RANDOM_BYTES).toString("hex")}${extension}`);
  await writeFile(path, body);
  return path;
};
