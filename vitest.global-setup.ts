import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// テストは mkdtemp した一時フォルダを片付けないものが多い。実行ごとの一時フォルダに集め、終わったらまとめて消す
// （worker と子プロセスは環境変数を引き継ぐので、os.tmpdir() がここを指す）
const RM_RETRIES = 5;

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "clodex-test-run-"));
  for (const name of ["TEMP", "TMP", "TMPDIR"]) process.env[name] = root;
  return () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: RM_RETRIES });
    } catch {
      // 子プロセスが掴んだままのファイルは残る。次の実行には影響しない
    }
  };
}
