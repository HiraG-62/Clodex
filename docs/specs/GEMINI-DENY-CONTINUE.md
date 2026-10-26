# GEMINI-DENY-CONTINUE: Gemini のソフト拒否から自動で続行させる

agy は headless だと承認が要る tool（RunCommand・CallMcpTool 等）を denied にしてターンを打ち切る（`result.denied_actions`。docs/spikes/antigravity.md）。ユーザーから見ると「前置きだけ返して止まる」。denied 付きでターンが完了したら、Coordinator が続行の指示を 1 回だけ同じ Agent に積む。仕様の正は `docs/DESIGN.md` §9 Permission（更新済み）。

## Fixed

- `TurnResult`（`src/agents/agent-adapter.ts`）に `deniedTools?: readonly string[]` を追加する。設定するのは AntigravityAdapter だけ（denied_actions の `display_name ?? action` の一覧。既存の error の emit は残す）
- Coordinator: ターンが `completed` かつ `deniedTools` が空でないとき、その Agent の mailbox に続行の入力を 1 回だけ積む
  - 本文（英語）: `[Clodex] These tools were denied by the current permission mode: <names>. Do not retry them. Continue with what you can, give your answer from what you already have, and say which permission is missing if needed.`
  - 対象は人間の入力・formal message の配送どちらのターンでもよい
  - ループ防止: 続行の入力で始まったターンがまた denied で終わっても、積み直さない。次の新しい入力（人間・formal message）で解除する
  - 設定用ターン（model/effort 変更など、turn を出さないもの）と `interrupted` / `failed` のターンには積まない
- Budget: 続行の入力は人間の入力と同じ扱い（chain を増やさない）。feed への表示は通常の envelope と同様でよいが、人間の発言と紛れない形にする（既存の `[Clodex]` 系 envelope の流儀に従う）
- テスト: AntigravityAdapter（deniedTools が TurnResult に入る）、Coordinator（1 回だけ積む・連続 denied で積み直さない・新しい入力で解除）
- `docs/DESIGN.md` は更新済み。編集しない

## Discretion

- Coordinator 内の実装位置（mailbox の完了ハンドラか、配送ループか）
- 続行フラグの持ち方
- 文言の微調整（趣旨が変わらない範囲）

## 編集してよいファイル

- `src/agents/agent-adapter.ts`・`antigravity-adapter.ts` と各テスト
- `src/coordinator/`（coordinator.ts・agent-mailbox.ts の該当箇所）と各テスト
