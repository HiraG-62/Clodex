import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// 一時ファイルに書いてから置き換える。書き込み途中で落ちても元のファイルを壊さない
export const writeFileAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content);
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
};
