# Background task の lifecycle

実施日: 2026-10-11 / Claude Code 2.1.293（haiku、low）/ codex-cli 0.156.1

スクリプト: [`spikes/background-task.ts`](../../spikes/background-task.ts)。実行ごとの stdout は [`background-task-claude.raw.jsonl`](background-task-claude.raw.jsonl) と [`background-task-codex.raw.jsonl`](background-task-codex.raw.jsonl) に全件保存した。作業場所は `%TEMP%/clodex-background-spike`。

```powershell
$spikeDir = Join-Path $env:TEMP 'clodex-background-spike'
New-Item -ItemType Directory -Force -Path $spikeDir | Out-Null
pnpm exec tsx spikes/background-task.ts claude $spikeDir docs/spikes/background-task-claude.raw.jsonl
pnpm exec tsx spikes/background-task.ts codex $spikeDir docs/spikes/background-task-codex.raw.jsonl
```

## Claude

最初の試行では Bash を呼ばずに `LAUNCHED` と返した。プロンプトを具体化した 2 回目で、親が `Bash` の `run_in_background: true` と `sleep 12` を呼んだ。生ログの順序は次のとおり。

| 行 | event | 観測した値 |
|---:|---|---|
| 6 | `system/background_tasks_changed` | `tasks` に `task_type: local_bash`、`task_id: brwlsl7t8`、`description: sleep 12` |
| 7 | `system/task_started` | `task_type: local_bash`、`is_backgrounded: true`、`tool_use_id` あり |
| 10 | `result/success` | 親の最初のターンが終了。Bash は実行中 |
| 11–13 | `task_updated` → `task_notification` → `background_tasks_changed` | 通知の `status: completed`、一覧は 0 件 |
| 14 以降 | `system/init` → `assistant` → `result/success` | 完了通知を受けた親の自発ターン |

終了通知には `task_type` がない。実行中の全件は `background_tasks_changed.tasks` の `local_bash` から取れる。既存の [`claude-subagent.md`](claude-subagent.md) では、子 Agent の Bash は `task_started.owned_by_subagent: true` で、親の `background_tasks_changed.tasks` には入っていなかった。`owned_by_subagent` のある Bash も除外する。

## Codex

`codex app-server generate-ts --experimental` で `thread/backgroundTerminals/list` と `item/completed` を確認した。`initialize.capabilities.experimentalApi: true` がない場合、一覧 API は `-32600` を返した。1 回目の実行では通常のコマンドとしてターン内に終了した。2 回目は `yield_time_ms=1000` を指定させた結果、以下を観測した。

| 順序 | event / API | 観測した値 |
|---:|---|---|
| 1 | `item/started` | `type: commandExecution`、`id: exec-1bf4…`、`processId: 80287`、`source: unifiedExecStartup`、`status: inProgress` |
| 2 | `turn/completed` | 親のターン終了。コマンドはまだ実行中 |
| 3 | `thread/backgroundTerminals/list` | `data` が 1 件。`itemId`、`processId`、`command` を返す |
| 4 | `item/completed` | 同じ `id` の `commandExecution`、`status: completed`、`exitCode: 0` |
| 5 | `thread/backgroundTerminals/list` | `data` が 0 件 |

Clodex はターン終了時に一覧を取り、実行中の端末を表示する。終了後は同じ `itemId` の `item/completed` で外す。プロセス終了時も空にする。
