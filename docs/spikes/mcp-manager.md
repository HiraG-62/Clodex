# MCP Manager CLI 設定 spike

スクリプト: `spikes/mcp-manager.ts`。2026-10-24、Windows で実測。各 CLI の設定先を一時ディレクトリに切り替え、モデルのターンは開始していない。

| CLI | 版 | 設定先と形式 | 隔離 | 公式コマンド |
|---|---|---|---|---|
| Claude Code | 2.1.308 | user: `$CLAUDE_CONFIG_DIR/.claude.json` の `mcpServers`、project: cwd の `.mcp.json` の `mcpServers` | `CLAUDE_CONFIG_DIR` と cwd | `claude mcp add-json --scope user\|project <name> <json>`、`remove --scope ... <name>` |
| Codex CLI | 0.156.1 | `$CODEX_HOME/config.toml` の `[mcp_servers.<name>]` | `CODEX_HOME` | `codex mcp add <name> --url <url>` または `--env KEY=VALUE -- <command> ...`、`remove <name>` |
| Antigravity CLI (`agy`) | 1.4.7 | `$USERPROFILE/.gemini/config/mcp_config.json` の `mcpServers` | `HOME` と `USERPROFILE` を同じ一時先に設定 | `agy mcp add [--env KEY=VALUE] <name> <commandOrUrl> [args...]`、`remove <name>` |

## 実測した形

- Claude stdio: `{ "type": "stdio", "command": "node", "args": ["server.js"], "env": { "SPIKE_VALUE": "${SPIKE_VALUE}" } }`。HTTP: `{ "type": "http", "url": "https://example.invalid/mcp" }`。`add-json` と `remove` は他の JSON キーを保持した。
- Codex stdio: `[mcp_servers.spike-stdio]` の `command`, `args` と `[mcp_servers.spike-stdio.env]`。HTTP: `url`。`add` と `remove` の後も既存のコメントと未知の `[custom]` が残った。project scope のコマンドはない。
- `codex mcp list --json` は会話を始めず、`name` と `transport`（stdio の `command`, `args`, `env`、HTTP の `url`）を含む一覧を返した。読み込みにはこの公式コマンドを使用できる。
- `codex mcp add` を同じ名前で再実行すると、既存の URL が更新された。
- agy stdio: `command`, `args`, `env`, `disabled: false`。HTTP: `serverUrl`, `disabled: false`。`mcp add` と `remove` は別の登録を残した。`src/agents/agy-mcp-config.ts` と同じファイル。
- 3 CLI とも `env` の `${SPIKE_VALUE}` は設定に文字列として保存された。実行時の展開はモデルのターンを開始しないと確認できないため未確認。`envRefs` の適用は対応未確認として警告する。
- 3 CLI とも HTTP 設定の保存を確認した。接続・認証は未確認。

## 書き込み方式

Codex は公式コマンドがコメントと未知のキーを保持したため、`codex mcp add/remove` を使える。Claude と agy は既存キーを保つ JSON の差分更新も可能。ただし Claude の user 設定は CLI 自身が更新するため、実装では変更検出をしてから操作する。
