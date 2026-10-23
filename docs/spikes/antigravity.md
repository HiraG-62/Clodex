# Antigravity CLI（agy）の headless（2026-10-26）

スクリプト: `spikes/antigravity.ts <probe>`（probe: single / multi / resume / plan / mcp）。agy 1.4.6、モデルは `gemini-3.8-flash-low` で実測した。**実行はターンごとに Google AI プランの利用枠を消費する**（1 ターン入力 約 6.8k token）。

## 導入と場所

- インストール: `irm https://antigravity.google/cli/install.ps1 | iex`（ユーザー単位）。実体は `%LOCALAPPDATA%\agy\bin\agy.exe`（ユーザー PATH に追加される。既存のプロセスの PATH には無いので Clodex からはフルパス解決が要る）
- データは `~/.gemini/antigravity-cli/`（settings.json・conversations・history.jsonl・MCP の tool スキーマのキャッシュ `mcp/<server>/<tool>.json`）
- 認証は agy 自身の Google OAuth ログイン（初回の対話で実施）。認証キャッシュが無い headless は `authentication required` で即終了（ハングしない。docs）

## headless の形（Clodex の Adapter にそのまま載る）

- 単発: `agy -p "<prompt>" --output-format stream-json`。NDJSON で `init` → `step_update`... → `result`
- **1 プロセス複数ターン**: `--input-format stream-json --output-format stream-json` で、stdin に 1 行 1 JSON `{"event":"user","message":{"content":"..."}}`。`init` は 1 回、ターンごとに `result`。`num_turns`・`usage` はセッション累積。stdin を閉じると今のターンを終えて exit 0
- 実測したイベント:
  - `init`: `{conversation_id, init:{model, cwd, tools:[...], permission_mode}}`。tools には組み込みの `send_message`・`run_command`・`view_file` など約 60 個（**組み込みに `send_message` があり、Clodex の MCP tool と同名**。MCP の呼び出しは `call_mcp_tool` 経由なので衝突はしないが、定型文では「clodex MCP server の send_message」と明示する必要がある）
  - `step_update`: `{conversation_id, step_index, state: ACTIVE|DONE, step_type: user_input|agent_response|tool|checkpoint, text_delta?, duration_seconds?, usage?, tool_info?: {name, parameters, output?, error?}, subagent_info?}`。`agent_response` の本文は `text_delta` の連結
  - `result`: `{conversation_id, status, response, duration_seconds, num_turns, usage:{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}, denied_actions?}`
- 再開: 別プロセスで `--conversation <conversation_id>`。前の会話の内容を覚えていた（pong の実測）。`-c` は直近の会話
- Git Bash の pipe でも stdout は落ちない（古い版の既知問題は 1.4.6 では再現せず）
- 診断（権限の拒否・認証・進捗）は stderr。成功は exit 0

## model / effort / mode

- `agy models` の一覧は slug に effort 込み（`gemini-4-argon-medium`・`gemini-3.8-flash-low` など。プラン経由の Claude Opus/Sonnet 5.5・GPT-OSS 120B も並ぶ）。別に `--effort low|medium|high|xhigh|max` もある
- `--mode accept-edits|auto|plan` がある。`--mode plan` でファイル作成を頼むと作成しなかった（ただし `init.permission_mode` は `request-review` のままで、モードはイベントに出ない）。Clodex の permission の対応候補: read-only=`--mode plan`、edit=`--mode accept-edits`、full=`--dangerously-skip-permissions`
- 未知の `--model` は exit 1 の ERROR（フォールバックしない。docs）

## permission（headless）

- 承認が要る tool（`run_command` など）は headless では**ソフト拒否**: ターンは SUCCESS で終わり、`result.denied_actions: [{action:"command", display_name:"RunCommand"}]` が付き、stderr に allow-rule の案内が出る
- 事前許可は `~/.gemini/antigravity-cli/settings.json` の `permissions.allow`（`command(git)`・`write_file(src/)`・`mcp(server/tool)`・`mcp(server/*)` の形。docs）。作業ディレクトリ内の読み書きは自動許可
- 作業フォルダの信頼: settings.json に `trustedWorkspaces` があるが、信頼していない `E:\dev\` の下でも headless は普通に動いた（プロンプトで止まらない）

## MCP（Clodex の send_message を渡す経路）

- 設定は 2 層: グローバル `~/.gemini/config/mcp_config.json`、workspace `<cwd>/.agents/mcp_config.json`（`{"mcpServers": {"<name>": {"command","args"} | {"serverUrl","headers"}}}`）。リモートは Streamable HTTP のみ（HTTP+SSE は非対応）。CLI からは `agy mcp add [-t http] <name> <commandOrUrl>` でも書ける
- **実測**: workspace 設定の stdio サーバーが使われ、`CLODEX_MCP_URL` を Clodex → agy → MCP 子プロセスへ環境変数で引き継げた。tool 呼び出しは `step_update` の `tool_info: {name:"call_mcp_tool", parameters:{Arguments:...}}`
- Clodex の MCP URL は会話ごと（ランダムポート + token）なので、静的な設定ファイルに直接書けない。**成立した案**: stdio の中継（proxy）を設定に 1 回書き、URL は agy の起動時の環境変数で渡す（agy は自分の env を MCP の子プロセスへ引き継ぐ）
- agy は MCP の tool スキーマを `~/.gemini/antigravity-cli/mcp/` にキャッシュし、呼ぶ前に `read_file` で読むことがある
- 実測は `--dangerously-skip-permissions` で行った。実運用は `permissions.allow` に `mcp(clodex/*)` を足す形になる見込み（未検証）

## 利用枠

- ターンごとの `result.usage` 以外に、headless から利用枠（5 時間 / 週）を取る経路は見つかっていない。`/usage` は print モードでは CLI のコマンドとして展開されず、モデルがコマンド実行を試みてソフト拒否された。stream-json の stdin ではスラッシュコマンドは ERROR（docs）。残量の表示は対話 UI のみ
- → Clodex の利用枠ゲージは、当面 gemini は token 累積（`usage`）だけで、5 時間 / 週の percent は unknown になる

## 未実測（G4 の前に足す）

- ターン中の中断: stdin に control は送れない（ERROR）。プロセスを kill → `--conversation <id>` で再開、の線が有力（未実測）
- `permissions.allow` の実際の効き方（`mcp(clodex/*)`・`command(...)` を settings に書いた場合）
- `--mode` と `--dangerously-skip-permissions` の併用、途中での権限変更（プロセス再起動が要るか）
- subagent（`subagent_info`）・context の残量の取得・compact 相当の操作

## 結論

agy 1.4.6 の headless は、stdin/stdout の 1 行 1 JSON・1 プロセス複数ターン・`--conversation` の再開がそろっていて、Clodex の `AgentProcess` / `BaseAgentAdapter` の形にそのまま載る。MCP も「stdio 中継 + 環境変数で URL」で会話ごとの接続が成立する。利用枠の percent と中断だけ制約が残る。
