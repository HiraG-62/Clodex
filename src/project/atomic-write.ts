import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_DELAY_MS = 20;
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

const renameWithRetry = (source: string, destination: string): void => {
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt === RENAME_ATTEMPTS) throw error;
      Atomics.wait(wait, 0, 0, RENAME_RETRY_DELAY_MS);
    }
  }
};

// 一時ファイルに書いてから置き換える。書き込み途中で落ちても元のファイルを壊さない
export const writeFileAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content);
    renameWithRetry(tempPath, path);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // 後始末の失敗より保存時の例外を優先する
    }
    throw error;
  }
};
