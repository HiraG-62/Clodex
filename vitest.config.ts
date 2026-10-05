import { defineConfig } from "vitest/config";

// 実 CLI の E2E はサブスクリプションの利用枠と CLI の状態を共有するので、ファイルを直列に実行する
const runE2e = process.env.CLODEX_E2E === "1";

export default defineConfig({
  test: {
    fileParallelism: !runE2e,
  },
});
