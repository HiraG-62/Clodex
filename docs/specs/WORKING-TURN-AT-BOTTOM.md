# WORKING-TURN-AT-BOTTOM: 作業中のターンをログの一番下に置く

今は作業中のターンの枠を始めた位置に置き、後ろに別の項目が並ぶと最終応答を末尾の別の項目に分けて、↑↓ のボタンで行き来させている（`resultId` / `processId`）。これをやめ、作業中のターンは常にログの一番下に置き、終わったらその時点の末尾に枠ごと置く。仕様の正は `docs/DESIGN.md` §17 ログの「作業中のターンの枠は、ログの一番下に置く」。

## 変更

1. **timeline**（`src/web/client/timeline.ts`）
   - 最終応答を分ける処理（`turn` event での `later` の判定、`resultId` / `processId`、`ownItem`）を消す。turn の型から `resultId` / `processId` を消す
   - `turn` event（終わり）を受けたら、そのターンの項目を `items` の末尾に移す（そこで固定）
   - 表示用に、作業中のターンを一番下へ並べ替える純粋な関数を足す（例: `withWorkingTurnsLast(items)`。作業中のターンを始めた順に末尾へ。ほかの項目の相対順は変えない）。画面は `withStartingTurns` / `withSubagentRows` と組み合わせ、一番下の並びを「作業中のターン → 起動中の行 → subagent の行」にする
   - `workingFeed`（作業ログ）は `processId` を見ている部分を消す（直近 2 ターンの数え方はそのまま）
   - message をターンにまとめる処理（MESSAGE-IN-TURN）は今のまま。自動の RESULT は直前に終わったターン（末尾に移ったもの）に入る
2. **描画**（`src/web/client/client-main.ts`）
   - ↑↓ の跳ぶボタン（`jumpButton` など、`resultId` / `processId` を使う部分）と、その文言・CSS を消す
   - 作業中のターンが一番下に来るよう、描画の順を 1 の関数の結果にする。終わったターンが末尾に移るとき、画面の DOM も並べ直す（今の差分描画の仕組みで並びが変わることを確かめる）
   - ログの一番下を見ていたら、今どおり新しい内容に合わせて下へスクロールする
3. **保存**: feed は event の順のまま。読み込み直し（`rebuildTimeline`）でも同じ並びになる
4. TUI（`src/tui/`）は今のまま（別に見直す）

## テスト方針

- `timeline.test.ts`
  - 作業中に人の入力・相手の message が届いても、表示の並びでは作業中のターンが一番下
  - 終わったターンは、その時点の末尾に移り、以後は動かない（後から届いた項目はその下）
  - 両 Agent が作業中なら、始めた順に一番下
  - 一番下の並び: 作業中のターン → 起動中の行 → subagent の行
  - `rebuildTimeline` でも同じ並び
  - 今の「最終応答を末尾の別の項目に出す」テストは、新しい決まりに合わせて書き直す（分けない）
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で確かめる（feed を差し込んで、作業中のターンの上に人の入力が並ぶ状態と、終わった後の並び）。スクリーンショットの path を RESULT に書く
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
