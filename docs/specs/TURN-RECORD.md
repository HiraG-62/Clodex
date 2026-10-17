# TURN-RECORD: 実行したコマンドと終了コード、再送を記録に残す

「テストを通した」が Agent の自己申告に頼っている。Coordinator が実際に実行したコマンドと結果（終了コード、取れなければ失敗の印）を持ち、依頼の再送も Event Log に残す。仕様の正は `docs/DESIGN.md` §9 の `AgentEvent` の表と「コマンドの記録」、§17 の Event Bus の表と WorkRecorder の段落、Event Log の terminal 表示の表。

## 手順

### 1. spike（先に行う。CLAUDE.md「CLI の挙動に依存する変更は spikes/ で実測」）

- Codex: `docs/spikes/background-task-codex.raw.jsonl` に `commandExecution` の `item/completed`（`exitCode`・`cwd`・`aggregatedOutput`・`durationMs`）が既にある。成功のコマンドしか無いので、失敗するコマンド（例: `exit 3`）の `exitCode` を確かめる。既存の `spikes/codex-app-server.ts` などを流用してよい
- Claude: `-p --output-format stream-json` で Bash を 2 回（成功 `exit 0` と失敗 `exit 3`）実行させ、`user` の `tool_result` の `is_error`・`content`・`tool_use_result`（`stdout`・`stderr`・`interrupted` など）に終了コードが取れる形で入るかを確かめる
- 記録: `spikes/command-exit.ts`（実行スクリプト）、`docs/spikes/command-exit.md`（結論）、raw の jsonl。実 CLI の呼び出しは上の数回だけにする
- 結論で終了コードが取れない（または文字列の解析が不安定）なら、Claude は `failed`（`is_error`）だけにする

### 2. Adapter（`src/agents/agent-adapter.ts`・`codex-adapter.ts`・`claude-adapter.ts`）

- `tool` に `toolId?: string`・`cwd?: string`・`exitCode?: number` を足す。新しい event `{ type: "tool_end"; toolId: string; exitCode?: number; failed?: boolean }` を足す
- Codex: `commandExecution` の `tool`（name: `command`）に `toolId`（item.id）・`cwd`・`exitCode`（`null` なら付けない）。`tool_end` は出さない。他の item の `tool` も `id` があれば `toolId` を付けてよい
- Claude: `tool_use` の `id` を `toolId` に。`user` event の `tool_result`（`parent_tool_use_id` 付きは無視）で、`Bash` の `tool_use_id` に一致するものに `tool_end` を出す。Bash 以外の結果は出さない（Bash の `tool_use_id` は adapter 内に覚えておき、ターンの終わりか session の切り替えで捨てる）
  - 今の `case "user": return this.handleReplay(event)` は replay だけを見ているので、`tool_result` の処理を足す（replay の処理は壊さない）
- 背景実行（`run_in_background`）の Bash は、起動の結果が返るだけなので `tool_end` に終了コードを付けない（`failed` は `is_error` どおり）

### 3. WorkRecorder（`src/coordinator/work-recorder.ts`）

- ターンごとに `commands: { toolId?: string; command: string; cwd?: string; exitCode?: number; failed?: boolean }[]` を持つ（1 ターン 200 件まで。定数にする。古いものから捨てる）
  - Codex の `command` の `tool` と、Claude の `Bash` の `tool`（入力の `command`）を記録する。Claude の `tool` の `input` は要約なので、コマンドの文字列の出どころは実装で決めてよい（要約で切れるなら、`tool` に要約前のコマンドを別フィールドで持たせてもよい）
  - `tool_end` は同じ Agent の今のターンの `toolId` に結び付ける
- 外から読めるようにする（例: `lastWork(id).commands`）。今の `actions`・`files`・復旧の `lastWork` の挙動は変えない

### 4. 再送の event（`src/coordinator/coordinator.ts`、Event Bus の型）

- `deliver` の再送（`attempt > 1`）のとき、Event Bus に `{ kind: "retry", to, messageId, attempt }` を publish する
- Event Log（`src/logging/event-log.ts`）: file は今どおり全 event。terminal は `/verbose` のときだけ（DESIGN §17 の表）。`tool_end` も `/verbose` のみ
- Web の feed（DESIGN §17「`agent` event のうち、ログに表示するもの」）には `tool_end` と `retry` を足さない。`retry` を feed や画面に出す必要が型の都合で出たら QUESTION

## テスト方針

- Codex adapter: `commandExecution` の completed（成功・失敗・`exitCode: null`）から `tool` の `toolId`・`cwd`・`exitCode`
- Claude adapter: `tool_use`（Bash）→ `tool_result`（成功・失敗）で `tool_end`。subagent の結果・Bash 以外の結果は出ない。replay の既存テストが通る
- WorkRecorder: コマンドと終了コードの結び付け、上限、ターンの切り替え
- Coordinator: 再送で `retry` が 1 回出る（既存の再送テストの形に合わせる）
- event-log: `tool_end`・`retry` は既定の terminal に出ず、`/verbose` で出る
- 最後に `pnpm test`・`pnpm typecheck`・`pnpm lint` を 1 回ずつ。spike を足したので `pnpm test:spikes` も通す（実 CLI を呼ぶ部分は既存の spike と同じく実行時だけにする）。コミットはしない

## 触ってよいファイル

- `src/agents/agent-adapter.ts`・`codex-adapter.ts`・`claude-adapter.ts`（とテスト）、`src/coordinator/work-recorder.ts`・`coordinator.ts`・Event Bus の型のファイル（とテスト）、`src/logging/**`
- `spikes/command-exit.ts`、`docs/spikes/command-exit.md`、`docs/spikes/command-exit*.raw.jsonl`
- 型の追従が要る画面・Hub のファイル（`switch` の網羅など）
- 生成コマンドが書き換えるファイル
- `docs/DESIGN.md` は触らない（矛盾を見つけたら QUESTION）
