# BACKGROUND-TASKS: 裏で動いているコマンドを画面に出す

Agent がコマンドを裏で動かして（Claude の `run_in_background` の Bash など）完了を待つ間、本体のターンは終わって待機中になり、コマンドが動いているのか分からない。動いている subagent と同じ置き方で、background task も出す。仕様の正は `docs/DESIGN.md` §28 C「マルチエージェント」の subagent の表示と、その下の background task の項。

## 1. 実測（人の了承済み。利用枠を少し使う。短いプロンプト・安い model で）

- `spikes/background-task.ts <claude|codex>` を作り、結果を `docs/spikes/background-task.md` に書き、`docs/spikes/README.md` の表に 1 行足す
- Claude（`claude -p --input-format stream-json --output-format stream-json --verbose`、今の Adapter と同じ起動引数）: 本体に `run_in_background: true` の Bash（例: `sleep 15`）を動かさせ、すぐターンを終えさせる。出る event を記録する: `system/task_started`（`task_type`・`is_backgrounded`・`description`・`tool_use_id`）、`system/background_tasks_changed` の `tasks`、`system/task_notification`、完了後の自発ターン。subagent が動かす Bash（`owned_by_subagent`）との区別も確かめる（既存の `docs/spikes/claude-subagent.md` を参照）
- Codex（`codex app-server`）: 裏で動く端末・コマンドの仕組みがあるか（unified exec の background terminal など。app-server の型定義 `codex app-server generate-ts` や `--help` も見る）。あれば、長いコマンドを裏で動かさせ、開始・終了の通知と、ターンが終わった後も動いているかを記録する。無ければ「対象外」と記録する

## 2. 実装

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、アイコン、TUI、テストの fixture など）は確認せずに触ってよい。

- **Adapter**（`src/agents/claude-adapter.ts`・`codex-adapter.ts`、`agent-adapter.ts` の event の型）: 実測で決めた取り方で、一覧が変わるたびに `background_tasks` event（`{ running: Array<{ id; description }> }`、全件）を出す。Claude は subagent の `subagents` event と同じ流れ（`background_tasks_changed` の `tasks` のうち、本体が動かした background の Bash）。プロセスが終わったら空の一覧を出す（subagent と同じ）
- **Coordinator**: Agent ごとに最新の一覧を持ち、state の `AgentState.backgroundTasks` に入れる（保存しない）
- **Web UI**: subagent と同じ
  - Agent ストリップのカードとスマホの Agent ピルに、動いているときだけ印（subagent とは別のアイコン、例: `terminal`。数を添える）。title に説明を並べる。スマホの Agent のシートに一覧
  - ログの末尾の行: Agent が作業中でなく、subagent か background task が動いているとき、Agent ごとの行に「バックグラウンド {数}」と説明を 1 行ずつ。subagent と両方あれば同じ行に並べる
- **TUI**: 下の行の Agent の状態に数を添える（subagent と同じ形）
- 文言は短く（ja「バックグラウンド {count}」/ en "Background {count}"）

## テスト方針

- Adapter: 実測の event の並び（spike の raw を fixture にしてよい）から `background_tasks` event が出る。subagent の Bash は数えない。終了で外れる
- Coordinator: state に入る
- Web UI: カードの印・ログの末尾の行（subagent と両方あるとき）
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、state に background task を差し込み、PC とスマホのスクリーンショットを撮って RESULT に path を書く
- `pnpm test`・`pnpm typecheck`・`pnpm lint`（spike を足したら `pnpm test:spikes` も）。コミットはしない。終わったら `send_message` の RESULT で報告する
