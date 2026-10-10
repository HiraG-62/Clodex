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
| J model の一覧と利用枠 | Claude は `control_request` の `initialize`（models）と `get_usage`（rate_limits）、Codex は app-server の `model/list` と `account/rateLimits/read` で、ターンを送らずに取れる | [model-list.md](model-list.md) |
| L restricted token | WRITE_RESTRICTED では home / APPDATA の削除が通る。通常 token なら拒否するが、読み取り・shell・子プロセス起動を制限し、Everyone 許可先への書き込みは残る。実 CLI は未実行 | [sandbox-token.md](sandbox-token.md) |
| M 専用ユーザー + WRITE_RESTRICTED | Deny なしの E: / 別 project と人の home の Win32 作成・削除を拒否。ツール・HKCU・MCP・broker 停止は成功。ただし ProgramData / Windows Temp に新規作成できる | [sandbox-hybrid.md](sandbox-hybrid.md) |
| N GUI の自動更新 | `tauri-plugin-updater` で、ダウンロード・署名の検証・NSIS の passive インストール・再起動（`/R`）までが動く。止めるのは GUI が起動した Hub だけ | [updater.md](updater.md) |
| O 割り込みの取り込み | Claude は `--replay-user-messages` の replay（送った uuid 付き）、Codex はターンの 2 つ目以降の `userMessage` で、割り込みを取り込んだ時点を検知できる | [steer-ack.md](steer-ack.md) |
| P Codex の project doc とネットワーク | `-c project_doc_fallback_filenames=["CLAUDE.md"]` で `CLAUDE.md` を読む（`AGENTS.md` が優先）。`workspace-write` は既定でネットワーク不可、`network_access` / `networkAccess` で Node・pnpm は通る（Schannel の TLS は不可） | [codex-project-config.md](codex-project-config.md) |
| Q Claude の background Agent | `task_started` / `task_notification` の `local_agent` で開始・終了、`background_tasks_changed.tasks` で稼働数を取れる。子の完了後、親の自発ターンが始まる | [claude-subagent.md](claude-subagent.md) |
| R Hub 異常終了時の孤児プロセス | PowerShell 経由の孫は残る。見張りでは親子関係の消失により止められず、Job Object は登録後に起動した孫まで停止した | [orphan-processes.md](orphan-processes.md) |
| T 別の作業ディレクトリでの resume | Claude は `-r <id>`、Codex は `thread/resume` の `cwd` で、別のディレクトリから session を続けられる。作業ディレクトリは新しい方に変わる | [worktree-resume.md](worktree-resume.md) |
| S Tailscale の接続状態 | `Running`・末尾に `.` のある DNS 名と、443 から Hub の 4319 番ポートへの Serve proxy を確認した | [tailscale.md](tailscale.md) |

## 設計への影響

- DESIGN.md §10 の Option A（Interactive PTY）/ B（Non-interactive + Resume）のどちらでもない **Option C: 構造化 stdio プロトコルの長寿命プロセス** を両 Agent の Adapter 方式として採用した（DESIGN.md §10）
  - Claude: stream-json（NDJSON）
  - Codex: app-server（JSON-RPC）
- PTY（Spike C）は Agent には使わず、将来の Process Manager（`!command` / `!& command`）用に残す
- 送信元の識別は MCP の URL path（`/mcp/claude`, `/mcp/codex`）で Coordinator が決める。Agent の自己申告に頼らない
- 起動時に認証方式を検査し、サブスクリプション以外なら起動を拒否する（DESIGN.md §26 の「API 従量課金を暗黙の fallback にしない」）

検証スクリプト: `spikes/*.ts`（`pnpm tsx spikes/<name>.ts <cwd>`）
