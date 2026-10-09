# Claude の background Agent の lifecycle

実施日: 2026-10-09 / Claude Code 2.1.293 / 親・子とも `haiku`（ログ上の resolved model は `claude-haiku-5-5`）

```powershell
$spikeDir = Join-Path $env:TEMP 'clodex-subagent-spike'
New-Item -ItemType Directory -Force -Path $spikeDir | Out-Null
pnpm exec tsx spikes/claude-subagent.ts $spikeDir docs/spikes/claude-subagent.raw.jsonl
```

スクリプト: [`spikes/claude-subagent.ts`](../../spikes/claude-subagent.ts)。stdout の全 33 イベントを [`claude-subagent.raw.jsonl`](claude-subagent.raw.jsonl) に生の JSONL で保存した。実行は 1 回。親は 2 つの Agent を `run_in_background: true` で起動して `LAUNCHED` と返した。子の一方は即座に `QUICK`、もう一方は Bash の `sleep 8` 後に `SLOW` と返した。

## 観測結果

| 順序 | 生ログの行 | イベント | 観測した値 |
|---|---:|---|---|
| 1 | 4, 8 | 親 `assistant` の Agent `tool_use` | `input.run_in_background: true`、`input.description` は `Respond QUICK` / `Sleep then respond SLOW`。`id` はそれぞれ `toolu_012ieJu9dQcxEEuS1tGJVmeA` / `toolu_018XpKsckrVAfzWBUs7iLfpP` |
| 2 | 5, 10 | `system/background_tasks_changed` | `tasks` に実行中の `local_agent` が入り、長さは **1 → 2**。各要素に `task_id`、`run_id`、`task_type`、`subagent_type`、`description` がある |
| 3 | 6, 11 | `system/task_started` | `task_type: local_agent`、`is_backgrounded: true`、`tool_use_id` は親の Agent `tool_use.id`。`task_id` は `a90c5841ef5447d05` / `ada7297df6097bf06` |
| 4 | 7, 12 | 親 `user` の Agent `tool_result` | `tool_use_id` は起動時の ID。`tool_use_result.status: async_launched`、`agentId` は `task_id` と同じ。本文にも `agentId` が含まれる |
| 5 | 13, 18, 27 | 子 `assistant` | `parent_tool_use_id` に各 Agent `tool_use.id` が付く。遅い子は Bash `tool_use` の後に返答 |
| 6 | 14–16 | 速い子の終了 | `system/task_updated.patch.status: completed` → `system/task_notification.status: completed` → `system/background_tasks_changed` の `tasks` が 1 件。通知の `task_id` と `tool_use_id` で起動時に結合でき、`summary` と `usage` もある |
| 7 | 19, 24–25 | 遅い子の途中 | `system/task_progress` に子の `task_id`、`tool_use_id`、`last_tool_name: Bash`。Bash 自体も `task_started` / `task_notification` を出すが、`task_type: local_bash`、`owned_by_subagent: true`、`parent_task_id` が子の `task_id` |
| 8 | 28–30 | 遅い子の終了 | 同じ `task_updated` → `task_notification` → `background_tasks_changed`。`tasks` は **0 件** |

親の最初の `result/success`（20 行目）は遅い子の実行中に出た。その後、速い子の完了通知を契機に `system/init` → 親 `assistant` → `result/success`（21–23 行目）の自発ターンが始まり、遅い子はまだ動いていた。遅い子の完了後も同じ並び（31–33 行目）の自発ターンが始まった。親の `result.subagent_stats.completed` は順に 1、1、2。親の `result` を待つだけでは子の稼働終了は分からない。

`/interrupt` とプロセス途中終了は試していない。今回の 1 回では 2 件とも正常に完了し、通知のあとに親の自発ターンが出た。

## 結論

Clodex は `system/task_started` の `task_type: local_agent` と `is_backgrounded: true` で開始を取り、`system/task_notification` の同じ `task_id` の `status: completed` で終了を取れる。`tool_use_id` を親 Agent の `tool_use.id` に結び付けられる。稼働数は `system/background_tasks_changed.tasks` の `task_type: local_agent` の件数で直接読める。汎用の `task_started` / `task_notification` には子の Bash task も含まれるので、`task_type` または開始時に記録した `task_id` で区別する。
