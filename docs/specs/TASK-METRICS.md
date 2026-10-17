# TASK-METRICS: task 単位の計測と基準値の集計

改善の効果を task 単位の数字で比べられるようにする。Coordinator がターンと formal message を `taskId` に結び付けて JSONL に記録し、task ごとに集計して画面と `/status` に出す。あわせて、導入前の Event Log から同じ集計を推定する script を置く。仕様の正は `docs/DESIGN.md` §17「task 単位の計測」と §11 Message Schema の `rework`・`relatesTo`。

## 手順

### 1. 基準値の script（最初に行う）

`scripts/task-metrics-baseline.ts`（`node --experimental-strip-types` で動く形。既存の `spikes/*.ts` の書き方に合わせる）

- 入力: Event Log の JSONL のディレクトリ（既定 `~/.clodex/metrics-baseline/logs/`。引数で変えられる）。ファイル名は `<project 名>-<起動時刻>-<会話 ID の先頭>.jsonl`。1 行 1 event（`{ kind: "agent" | "message" | "human" | "notice", ..., at }`）
- ターンの推定: Agent ごとに `turn_started` → `turn` を 1 ターンとする。ターンの `taskId` は、そのターンの直前に宛先の mailbox に積まれていた（まだ配送されていない）message のうち最も古いもの。直前に人の入力（`human` で同じ Agent）があればそれを優先し、未割当にする。推定なので完全でなくてよい
- token: `context` event の `inputTotal`（session の累計）のターン前後の差。キャッシュの内訳は過去の記録に無いので合計だけ
- 出力（標準出力に Markdown の表。`--json` で JSON）
  - 全体: message 数・ターン数・期間
  - project ごと: DELEGATE 数、QUESTION 付きの DELEGATE の割合（1 件以上・2 件以上）、QUESTION/DELEGATE、Claude のターン終了時のコンテキストの中央値と 150k 超の割合、`RESULT` を受けたターンの入力 token の中央値、`fresh` と非 `fresh` の質問率
  - task ごとの指標（DESIGN の集計の項目）の分布（中央値・p90）、受入完了数・初回受入率
- 確認: ブレストの 1 周目の数字（message 1,214 件・ターン 1,961 件、DELEGATE の 44% に QUESTION 1 件以上・18% に 2 件以上、roguelike の QUESTION/DELEGATE 1.26、Claude のターン終了時のコンテキスト中央値 369k・92% が 150k 超）が、10/5〜10/16 の範囲で近い値になるか。大きくずれたら原因（推定の違い）を RESULT に書く。完全一致は求めない
- 結果を `docs/metrics/baseline-2026-10.md` に保存する（script の実行コマンド・入力の範囲・表）

### 2. message の schema（`src/protocol/messages.ts`）

- `rework?: "spec" | "impl" | "check"`（`DELEGATE`・`FIX`・`ADD` のみ。ほかは拒否）、`relatesTo?: string`（`DELEGATE`・`REVIEW_REQUEST` のみ）を `sendMessageShape` に足す。`describe` は短く英語で（例: `rework`: "Why this task is requested again: spec, impl or check"）
- envelope（`buildEnvelope`）に、あれば `Rework: …` / `Relates-To: …` の行を足す

### 3. Adapter の token（`src/agents/claude-adapter.ts`・`codex-adapter.ts`・`agent-adapter.ts`）

- 今の `context` / `input_total` event の累計に、キャッシュの内訳と出力を足す（例: `cachedInputTotal`・`outputTotal`）
  - Claude: 入力 = `input_tokens + cache_creation_input_tokens`、キャッシュ = `cache_read_input_tokens`、出力 = `output_tokens`（今の `inputTotal` と同じく `result` の usage を足していく）
  - Codex: `total.inputTokens` はキャッシュ分を含むので、入力 = `inputTokens - cachedInputTokens`、キャッシュ = `cachedInputTokens`、出力 = `outputTokens`
- 今の `inputTotal`（キャッシュ込みの合計）は他の表示で使っているので残す

### 4. 記録（新しいファイル `src/coordinator/task-metrics.ts` など）

- `TaskMetricsRecorder` が Event Bus を購読するか Coordinator から呼ばれ、DESIGN の `turn`・`message`・`delivery` のレコードを `~/.clodex/metrics/<key>.jsonl` に追記する（`<key>` は `conversationStatePath` と同じ project のキー）。書き込みの失敗は作業を止めない（Event Log と同じ扱い）
- ターンの `taskId`: Coordinator の mailbox が配送した項目の message（`mailbox.current` など）から決める。人の入力・自発ターン・`/compact` は未割当。割り込みで別の `taskId` の message を足したら、そのターンは未割当にする
- `delivery` の待ち時間: message の受理（`createdAt`）から mailbox が配送を始めるまで
- 集計の関数（純粋関数）: レコードの配列 → task ごとの集計と会話ごとの未割当の合計。受入完了・初回受入は DESIGN のとおり
- 並列の会話（parallel / worktree の子）も同じ project のファイルに書く（会話 ID で分かれる）

### 5. 画面と `/status`

- Web state に、今の会話の task の集計（`RESULT` のカードに出す分と `/status` の分）を足す。毎回ファイル全体を読まないよう、Hub のメモリに会話ごとの集計を持ち、起動時に一度だけファイルから作る
- `RESULT` の message カード（Web UI と TUI）に、その task の累計を小さく 1 行（例: ja「4 ターン · 入力 1.2M · 38 分 · 質問 1」/ en "4 turns · in 1.2M · 38 min · 1 question"）。数の書き方は今のコンテキストの表示に合わせる。カードの既存の印（auto・fresh）の並びに合わせる
- `/status` に今の会話の最近の task（5 件。最後の message の新しい順）の累計を 1 行ずつ
- 文言は短く（CLAUDE.md の UI 文言）

## テスト方針

- script: 小さな Event Log の fixture で、ターンの推定・QUESTION 付きの DELEGATE の割合・コンテキストの中央値が出る
- schema: `rework`・`relatesTo` の受け付けと、許されない type での拒否。envelope の行
- Adapter: キャッシュの内訳と出力の累計（Claude の usage・Codex の `total`）
- 記録: 配送したターンの `taskId`、人の入力・自発ターン・割り込みは未割当、session が変わったときの token の差、待ち時間
- 集計: ターン数・token・QUESTION・RESULT・再依頼・`rework` の内訳、受入完了と初回受入
- 画面: `RESULT` のカードの 1 行と `/status`。CLAUDE.md の「画面の確認（Web UI）」の手順で、一時の Hub の `~/.clodex/metrics/` に fixture を置いて PC とスマホ幅のスクリーンショットを `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に撮り、RESULT に path を書く
- 最後に `pnpm test`・`pnpm typecheck`・`pnpm lint` を 1 回ずつ。コミットはしない

## 触ってよいファイル

- `scripts/task-metrics-baseline.ts`（とテスト）、`docs/metrics/baseline-2026-10.md`
- `src/protocol/messages.ts`・envelope を作るファイル（とテスト）
- `src/agents/agent-adapter.ts`・`claude-adapter.ts`・`codex-adapter.ts`（とテスト）
- `src/coordinator/**`（新しいファイルを含む）、`src/hub/**`、`src/index.ts`、`src/cli/shell.ts`
- `src/web/**`（`client/` を含む）、`src/tui/**`、`src/i18n/messages.ts`
- 生成コマンドが書き換えるファイル
- `docs/DESIGN.md` は触らない（矛盾を見つけたら QUESTION）
- `~/.clodex/metrics-baseline/logs/` は読むだけ。書き換えない
