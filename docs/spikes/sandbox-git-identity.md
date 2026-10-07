# sandbox の Git 作者同期

2026-10-07。`pnpm exec tsx spikes/sandbox-git-identity.ts` で製品の同期処理を実行後、`pnpm exec tsx spikes/sandbox-debug-run.ts E:\dev\clodex-hybrid-test git config --global user.name` の結果が人の `git config --global user.name` と一致することを確認した。実 CLI のターン・commit は実行していない。

空白・日本語・引用符を含む作者値の引数配列、設定がない場合の保持、取得失敗の伝播をユニットテストで確認。`pnpm test` 769 passed / 5 skipped、`pnpm typecheck` と `git diff --check` 成功。
