import { defineConfig } from "vitest/config";

// 実 CLI の E2E はサブスクリプションの利用枠と CLI の状態を共有するので、ファイルを直列に実行する
const runE2e = process.env.CLODEX_E2E === "1";
// GitHub Actions の Windows の runner は PowerShell の起動が遅く、PowerShell を使うテストが既定の 5 秒を超えることがある
const CI_TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    fileParallelism: !runE2e,
    ...(process.env.CI ? { testTimeout: CI_TEST_TIMEOUT_MS } : {}),
  },
});
