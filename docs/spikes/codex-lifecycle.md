# Spike B — Codex CLI lifecycle

スクリプト: `spikes/codex-app-server.ts`

## 検証結果

| 項目 | 結果 |
|---|---|
| CLI launch | `codex.exe`（`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`）を直接起動できる |
| non-interactive | `codex exec --json "<prompt>"` で JSONL（`thread.started` / `turn.started` / `item.completed` / `turn.completed`）が出る。stdin が開いていると追加入力を待つので閉じておく |
| resume（exec） | `codex exec resume --json <thread_id> "<prompt>"` で文脈が継続した |
| 長寿命 session | `codex app-server`（JSON-RPC over stdio、`jsonrpc` フィールドなし）で `initialize` → `initialized` → `thread/start` → `turn/start` を繰り返し、1 プロセスで複数ターン処理できた |
| interrupt | `turn/interrupt {threadId, turnId}` で即座に `turn/completed`（status: `interrupted`）。直後の次ターンは正常に処理された |
| resume（app-server） | 別プロセスで `thread/resume {threadId}` → `turn/start` で過去 3 ターンの内容を覚えていた |
| exit | プロセス kill で終了 |
| authentication | `account/read` で `type: "chatgpt"` と plan を取得できる（Spike E） |
| MCP | `-c mcp_servers.<name>.url="..."` で動的に追加できる（Spike D） |

## 観測できる情報（通知）

- `turn/started` / `turn/completed`（status: completed / interrupted）
- `item/started` / `item/completed`（userMessage, agentMessage, mcpToolCall, commandExecution, fileChange 等）
- `item/agentMessage/delta`: ストリーミング出力
- `thread/status/changed`: active / idle
- `thread/tokenUsage/updated`: token 使用量
- `account/rateLimits/updated`: primary（5 時間）/ secondary（7 日）の usedPercent → Budget Manager の telemetry に使える
- サーバーからのリクエスト: `item/commandExecution/requestApproval` 等の承認要求（Coordinator が応答する必要がある）

## 注意点

- プロトコルは `codex app-server generate-ts --out <dir>` で TypeScript 型を生成できる。版で変わるので型は生成物を正とする
- app-server は experimental 扱い。版の更新で変わる可能性がある
- `approvalPolicy: "never"` だと承認が必要な操作は失敗する（MCP tool 呼び出しを含む。Spike D）

## 結論

Adapter は **app-server の長寿命プロセス** を基本とする。プロセスが落ちたときは `thread/resume` で継続する。PTY は不要。
