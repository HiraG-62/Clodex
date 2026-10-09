import { defineConfig } from "vitest/config";

// 実 CLI の E2E はサブスクリプションの利用枠と CLI の状態を共有するので、ファイルを直列に実行する
const runE2e = process.env.CLODEX_E2E === "1";
// git や PowerShell を起動するテストは、ファイルを並列に実行した負荷で既定の 5 秒を超えることがある
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    fileParallelism: !runE2e,
    testTimeout: TEST_TIMEOUT_MS,
  },
});
