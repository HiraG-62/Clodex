# Spike E — Authentication

スクリプト: `spikes/codex-auth.ts`、Claude は CLI で直接確認

## 検証結果

| 条件 | Claude | Codex app-server |
|---|---|---|
| 通常 | `claude auth status` → `authMethod: "claude.ai"`、`system/init` → `apiKeySource: "none"` | `account/read` → `type: "chatgpt"` |
| API key 環境変数あり（偽キー） | `ANTHROPIC_API_KEY` があると **API key が優先**される。`apiKeySource: "ANTHROPIC_API_KEY"`、`authMethod: "api_key"`。偽キーなので 401 になり、最大 10 回 retry して待ち続けた | `OPENAI_API_KEY` / `CODEX_API_KEY` があっても `type: "chatgpt"` のまま |

## 対策（Coordinator で実装する）

1. 子プロセスの環境変数から `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` / `CODEX_API_KEY` を取り除いて起動する
2. 起動直後に検査し、サブスクリプション認証でなければ Agent を停止してエラーにする
   - Claude: `system/init` の `apiKeySource === "none"`
   - Codex: `account/read` の `account.type === "chatgpt"`
3. Claude の `api_retry`（`error_status: 401`）を観測したら、retry を待たずに失敗として扱う

## 未検証

- Claude の `apiKeyHelper` 設定や、Bedrock / Vertex 等の 3P provider 環境変数がある場合（`system/init` の `apiKeySource` / provider で検出できる想定）
