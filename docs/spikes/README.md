# Phase 0 Spikes — 結果まとめ

実施日: 2026-10-05 / Windows 11 Pro 10.0.26200 / Node 22.13.1
CLI: Claude Code 2.1.289 / codex-cli 0.156.1

| Spike | 結論 | 詳細 |
|---|---|---|
| A Claude lifecycle | `claude -p --input-format stream-json --output-format stream-json` の長寿命プロセスで、複数ターン・interrupt・継続がすべて成立。PTY は不要 | [claude-lifecycle.md](claude-lifecycle.md) |
| B Codex lifecycle | `codex app-server`（JSON-RPC over stdio）で thread / turn / interrupt / 別プロセスからの resume がすべて成立。PTY は不要 | [codex-lifecycle.md](codex-lifecycle.md) |
| C Windows PTY | node-pty 1.1.0 + ConPTY は日本語・resize・Ctrl+C で動作。kill 時に子プロセスで `AttachConsole failed` が出る | [windows-pty.md](windows-pty.md) |
| D MCP | Coordinator 内の Streamable HTTP MCP server へ両 CLI から `send_message` を送れた。Codex は tool 承認設定が必要 | [mcp.md](mcp.md) |
| F 権限変更 | Claude は `set_permission_mode`、Codex は `turn/start` の `sandboxPolicy` で、再起動せずに権限を変えられる | [permission.md](permission.md) |
| G 手動 compact | Claude は `/compact` の送信、Codex は `thread/compact/start` で compact できる。どちらも 1 ターンとして動く | [compact.md](compact.md) |
| H `!command` | PowerShell は既定だと日本語が CP932 で化ける。UTF-8 指定を先頭に足せば pwsh / 5.1 とも正常。停止は `taskkill /T /F` | [shell-command.md](shell-command.md) |
| E Authentication | Claude は `ANTHROPIC_API_KEY` があると黙って API key 課金に切り替わる。Codex app-server は ChatGPT 認証のまま | [authentication.md](authentication.md) |
| I Windows のマウス | Node 22 の raw mode は Windows でマウスの入力を捨てる。raw mode の後にコンソールモードへ `ENABLE_VIRTUAL_TERMINAL_INPUT` を足すとホイールの SGR シーケンスが届き、キー入力も Ink が同じに解釈できる | [windows-mouse.md](windows-mouse.md) |
| J model の一覧 | Claude は `control_request initialize` の `models`、Codex は app-server の `model/list` で、ターンを送らずに表示名つきの一覧が取れる | [model-list.md](model-list.md) |

## 設計への影響

- DESIGN.md §10 の Option A（Interactive PTY）/ B（Non-interactive + Resume）のどちらでもない **Option C: 構造化 stdio プロトコルの長寿命プロセス** を両 Agent の Adapter 方式として採用した（DESIGN.md §10）
  - Claude: stream-json（NDJSON）
  - Codex: app-server（JSON-RPC）
- PTY（Spike C）は Agent には使わず、将来の Process Manager（`!command` / `!& command`）用に残す
- 送信元の識別は MCP の URL path（`/mcp/claude`, `/mcp/codex`）で Coordinator が決める。Agent の自己申告に頼らない
- 起動時に認証方式を検査し、サブスクリプション以外なら起動を拒否する（DESIGN.md §26 の「API 従量課金を暗黙の fallback にしない」）

検証スクリプト: `spikes/*.ts`（`pnpm tsx spikes/<name>.ts <cwd>`）
