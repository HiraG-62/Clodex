# Spike A — Claude Code lifecycle

スクリプト: `spikes/claude-stream.ts`

## 検証結果

| 項目 | 結果 |
|---|---|
| CLI launch | `claude.exe`（`%USERPROFILE%\.local\bin`）を `child_process.spawn` で直接起動できる |
| non-interactive | `claude -p "<prompt>" --output-format stream-json --verbose` で NDJSON イベント列が出る |
| session ID | 全イベントに `session_id` が付く。`--session-id <uuid>` で事前指定も可能 |
| resume | `claude -p "<prompt>" -r <session_id>` で同じ session ID のまま文脈が継続した |
| 長寿命 session | `-p --input-format stream-json --output-format stream-json` で stdin に `{"type":"user","message":{"role":"user","content":"..."}}` を 1 行ずつ送ると、1 プロセスで複数ターン処理できる。ターンごとに `system/init` → `assistant` → `result` が出る |
| interrupt | stdin に `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}` を送ると `control_response` が返り、そのターンは `result/error_during_execution` で終わる。直後の次ターンは正常に処理された |
| exit | stdin を閉じるとプロセスが終了コード 0 で終わる |
| authentication | `claude auth status` と `system/init` の `apiKeySource` で判定できる（Spike E） |
| MCP | `--mcp-config <json>` で動的に MCP server を追加できる（Spike D） |

## 観測できる情報

- `system/init`: model, `apiKeySource`, MCP server の接続状態
- `assistant`: text / thinking / tool_use の各ブロック
- `result`: `result`（最終テキスト）, `is_error`, `total_cost_usd`, `usage`, `duration_ms`
- `rate_limit_event`: `five_hour` / `seven_day` の utilization と resetsAt → Budget Manager の telemetry に使える
- `system/hook_started` / `hook_response`: ユーザーの hooks（SessionStart 等）も実行される

## 注意点

- ユーザー設定の hooks・MCP server・CLAUDE.md がそのまま読み込まれる。これは Native Harness First の方針どおりだが、起動時間とコンテキストに影響する（haiku で初回 cache_creation 約 27k token）
- `-p` モードでは workspace trust ダイアログが出ない
- `-p` モードでは許可されていない tool は自動拒否される。必要な tool は `--allowedTools` で許可する

## 結論

Adapter は **stream-json の長寿命プロセス** を基本とする。プロセスが落ちたときは `-r <session_id>` で再起動して継続する。PTY は不要。

## 自発ターン（2026-10-06 の Clodex 実行ログから）

`~/.clodex/logs/Clodex-20261006-014233.jsonl` で観測した。Claude に background の subagent を 3 つ起動させてターンを終えた後:

- `result` の後も、入力を送っていないのに `assistant`（subagent の tool 呼び出し・発言）が流れ続けた
- subagent が終わるたびに、Claude 本体が入力なしで新しいターンを始め、`assistant` → `result` を出した（`result` は Clodex の `context` event として記録されていた）
- Clodex は送信したターンが無い間の `result` を捨てていたため、`turn` event が出ず、最終応答が本文として表示されなかった

未確認（`spikes/claude-stream.ts` で実測する）:

- subagent の `assistant` に `parent_tool_use_id` が付くか
- 自発ターンの始まりに `system/init` 等の目印となる event が出るか
