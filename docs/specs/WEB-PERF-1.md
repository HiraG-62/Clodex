# WEB-PERF-1: 作業中のターンを丸ごと描き直さない・履歴を上限なく持たない

仕様は docs/DESIGN.md §17 Web UI の「使い勝手の決まり」（今回追記済み）。**見た目と振る舞いは変えない。** 変えるのは描き直す範囲と、持つ量だけ。

## 現状

- 作業中のターンに tool・text の event が来るたびに、ターンの item が新しいオブジェクトになり、`src/web/client/log-view.ts` の `renderLog` が `renderItem` でターンの要素を丸ごと作り直して `replaceWith` する。plan と本文の markdown、全ステップ、画像のプレビュー（`appendImagePreviews`）をすべて作り直す
- 画像は `/api/file` が `cache-control: no-store` なので、`<img>` を作り直すたびに取得し直す
- `renderWorking` は event のたびに作業パネルの全項目（markdown を含む）を作り直す
- `enhanceMarkdown(ctx.log)` が、毎回ログ全体の `pre` と `table` を走査する
- `ctx.store.history` は live の項目を上限なく足し続ける（`connection.ts:153`）。`items` は `timeline.ts` の `MAX_ITEMS`（1500）で切っているが、`history` は切らない。`opened`（details の開閉）も消さない

## 変更

### A. ターンの差分更新

- 同じ ID のターンが、作業中のまま新しい item になったときは、要素を作り直さず、変わったところだけ更新する（`log-item.ts` に `updateTurn(node, previous, next)` のような関数を作る）
  - ステップ: 増えた分だけ末尾に足す。既存のステップの内容が変わった（最後のステップの結果が届いた等）ときは、そのステップだけ作り直す。ステップの数の表示（`web.turn.steps`）も更新する
  - plan・本文: 文字が変わったときだけ markdown を作り直す
  - 画像のプレビュー: パスごとに要素を持ち、同じパスの要素は再利用する。消えたパスの要素だけ消す
  - 状態の表示（作業中・完了・失敗）・経過時間: 変わったら更新する
- ターンが終わった（status が working 以外になった）ときと、構造が大きく変わって差分で扱いにくいときは、今どおり作り直してよい
- `renderLog` の「作り直す」判定（`current.item !== item`）で、ターンなら差分更新の関数を使う

### B. 作業パネル

- `renderWorking` は、作業パネルの内容（`workingFeed` の結果）が前回と同じなら DOM に触らない。項目ごとに比べ、変わった項目だけ作り直す
- 経過時間は今どおり 1 秒ごとの書き換えで更新する（作り直しの理由にしない）

### C. markdown の後処理

- `enhanceMarkdown` は、作り直した・更新した要素にだけかける（ログ全体を走査しない）

### D. 持つ量

- `history` も `items` と同じ上限（`MAX_ITEMS`。定数を共有する）で、live の項目を足したときに古い方から切る。`items` が同じ切り方をしているので、表示される範囲は変わらない。上に読み足したとき（`/api/history`）は切らない（読み足した直後に消さないため）
- `opened` は、`rendered` から項目を消すときに、その ID の分も消す

## テスト

- 差分の判定（どのステップを足す・作り直すか、画像のパスの増減）は純関数にして、ユニットテストを書く
- `history` の上限と `opened` の削除のテスト
- 一時の Hub（`pnpm dev serve`。CLAUDE.md の「画面の確認」）で、Agent に短い作業を 1 回頼み（例:「`README.md` を読んで 1 行で要約して」）、作業中のターンの表示・ステップの開閉・完了後の表示が今と同じであることを確かめる。**利用枠を使うので、実行する前に claude に QUESTION で了承を取る。** ブラウザの Performance で、event が来たときにターンの要素が作り直されていない（`replaceWith` されない）ことを確かめ、RESULT に書く

## 変更してよいファイル

- `src/web/client/log-view.ts`・`src/web/client/log-item.ts`・`src/web/client/connection.ts`・`src/web/client/timeline.ts` と、それぞれのテスト（新規可）
- `src/web/client/` の新しい純関数のモジュールとそのテスト

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
