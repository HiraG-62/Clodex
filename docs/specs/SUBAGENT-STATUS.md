# SUBAGENT-STATUS: 動いているサブエージェントを画面に出す

本体のターンが終わると Agent は待機中になり、裏でサブエージェントが動いていても分からない。本体の状態はそのまま（待機中）にして、動いているサブエージェントを別に出す。仕様の正は `docs/DESIGN.md` §28「マルチエージェント」。実測: `docs/spikes/claude-subagent.md`（Claude）、`docs/spikes/steer-image-subagent.md`（Codex）。

## 変更

1. **event**（`src/agents/agent-adapter.ts`）: `AgentEvent` に `{ type: "subagents"; running: Array<{ id: string; description: string }> }` を足す（そのときの全件）
2. **Claude Adapter**（`src/agents/claude-adapter.ts`）
   - `system` の `subtype: "background_tasks_changed"` で、`tasks` のうち `task_type === "local_agent"` を `{ id: task_id, description }` にして `subagents` を出す。前回と同じ一覧なら出さなくてよい
   - プロセスが終わったら（`handleExit` 相当）、一覧が空でなければ空の `subagents` を出す
   - このイベントはターンの外でも来る（本体の `result` の後）。ターンの開始・終了には影響させない
3. **Codex Adapter**（`src/agents/codex-adapter.ts`）
   - 親の thread の `subAgentActivity` で、`kind: "started"` なら `{ id: agentThreadId, description: agentPath }` を足し、`completed` なら外して、`subagents` を出す。今の `tool` event（作業の 1 行）は残す
   - プロセスが終わったら空の一覧を出す
4. **Coordinator**（`src/coordinator/coordinator.ts`）と state
   - Agent ごとに最新の一覧を持ち、`status()` の `AgentState` に `subagents: Array<{ id; description }>`（無ければ空配列）を入れる。一覧が変わったら state を更新する（今の state の通知の仕組みに乗せる）
   - 保存・復旧はしない
5. **Web UI**（`src/web/client/client-main.ts`、`src/web/web-page.ts`、必要ならアイコン）
   - Agent ストリップのカードとスマホの Agent ピル: `subagents.length > 0` のときだけ、小さな印（アイコンと数）を出す。title（`aria-label` も）に説明を改行で並べる。文言を足すなら見出し程度（ja「サブエージェント」/ en "Subagents"）。「この〜」の言い回しは使わない
   - スマホの Agent のシート: 説明の一覧を出す（無ければ出さない）
   - 本体の状態の表示（待機中など）は変えない
6. **TUI**（`src/tui/`）: 下の行の Agent の状態に数を添える（例: `claude 待機中 · sub 2`。既存の書き方に合わせる）

## テスト方針

- `claude-adapter.test.ts`: `background_tasks_changed` で `local_agent` だけが `subagents` に入る（`local_bash` は入らない）。1 → 2 → 1 → 0 の変化。ターンの外で来てもターンを始めない。プロセス終了で空になる。`docs/spikes/claude-subagent.raw.jsonl` の行をそのまま使えるなら使う
- `codex-adapter.test.ts`: `subAgentActivity` の started / completed で一覧が増減する。ほかの thread の通知は今どおり無視
- `coordinator.test.ts`: `subagents` event で `status()` の `subagents` が変わる
- Web: 印と title を組み立てる部分を純粋な関数に切り出せるならテストする。見た目は Playwright で、ビルド版の Hub（`pnpm exec tsc -p tsconfig.build.json --outDir <一時フォルダ>`、`CLODEX_HOME=<一時フォルダ>` と別ポート）に state を差し込むか DOM を差し込んで確かめ、スクリーンショットを `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存する
  - **注意**: 一時ホームに実データ（`~/.clodex/state`）を写すときは `*.recovery.json` を消してから起動すること（写したままだと作業中だった Agent を本物のセッションで起動してしまう）。実データは写さず空のホームで確かめるのがよい
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
