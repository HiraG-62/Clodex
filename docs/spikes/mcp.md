# Spike D — MCP

スクリプト: `spikes/mcp.ts`

## 構成

```text
Coordinator プロセス内
  └── HTTP server 127.0.0.1:<random port>
        ├── /mcp/claude  ← Claude 用
        └── /mcp/codex   ← Codex 用
              └── tool: send_message(to, type, taskId, objective, files?)
```

- `@modelcontextprotocol/sdk` 1.32 の `McpServer` + `StreamableHTTPServerTransport`（stateless、`enableJsonResponse: true`）
- 送信元（`from`）は URL path で Coordinator が決める

## 検証結果

| Agent | 接続方法 | 結果 |
|---|---|---|
| Claude | `--mcp-config '{"mcpServers":{"clodex":{"type":"http","url":".../mcp/claude"}}}' --allowedTools mcp__clodex__send_message` | `system/init` で connected。tool 呼び出しで正式メッセージを受信できた |
| Codex | `codex app-server -c mcp_servers.clodex.url=".../mcp/codex" -c mcp_servers.clodex.default_tools_approval_mode="approve"` | 承認設定なしでは `MCP tool call requires approval, but approval policy is never` で失敗。承認設定を付けると受信できた |

## Wake / Resume

MCP tool の受信から相手 Agent への配送は Coordinator の責務。Spike A / B で、両 Agent とも長寿命プロセスに新しいターンを送れること、プロセスが落ちても session / thread ID で resume できることを確認済み。したがって以下の流れが成立する。

```text
Agent A → MCP send_message → Coordinator（記録・上限チェック）
  → Agent B が idle なら新しいターンとして Task envelope を送る
  → Agent B が実行中ならキューに積み、ターン完了（result / turn/completed）後に送る
```

実行中ターンへの割り込み送信（Claude は stream-json への追加送信、Codex は `turn/steer`）は v0.1 では使わず、キューで直列化する。

## 結論

MCP は formal message の入口として両 CLI で実用可能。
