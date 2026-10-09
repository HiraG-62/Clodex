# WEB-BUNDLE-2: client-main.ts を機能ごとのモジュールに分ける（振る舞いは変えない）

WEB-BUNDLE-1 で client を esbuild の bundle にしたので、普通の import が使える。2687 行・可変の `let` 約 50 個の 1 関数（`clientMain`）を、機能ごとのモジュールに分ける。**画面の見た目と振る舞いは変えない。** 描画の改善（差分の更新）は次の spec（WEB-PERF-1）で行う。

## 方針

- 共有する状態（今の `let` のうち複数の機能が読み書きするもの: `state`・`history`・`items`・`rendered`・`opened`・接続中か・送信中のボタンなど）は、1 つの store オブジェクト（`src/web/client/store.ts` の型と作る関数）にまとめる。1 つの機能の中だけで使う状態は、その機能のモジュールの中に閉じる
- 各モジュールは `createXxx(ctx)` の形で、使う関数を返す。`ctx` は store と、ほかの機能を呼ぶための関数（例: `renderLog`・`showToast`・`send`・`openSheet`）を持つ。モジュール同士で import し合って循環しないよう、機能をまたぐ呼び出しは `ctx` 経由にする
- DOM の小さな道具（`el`・`icon`・`iconButton`・`$`）と表示の整形（`clock`・`shortDate`・`kTokens`・`t`）は、それぞれ 1 つのモジュールにする
- 分け方の目安（今のコメントの区切りに沿う。名前は任意）
  - `send.ts`（送信・処理中のボタン・設定の要求）、`toast.ts`、`theme.ts`
  - `log-view.ts`（ログの描画・作業中のターン・markdown の後処理・スクロール・新着ボタン）、`question-dock.ts`
  - `agent-strip.ts`（Agent の行・ゲージ・利用状況のポップオーバー・project の選択・会話のタブ）、`pending-view.ts`（送信待ち）
  - `sheets.ts`（シートの開閉・フォーカスの閉じ込めと戻し）、`conversations-sheet.ts`、`agent-settings-sheet.ts`、`settings-sheet.ts`（GUI の更新・通知の節を含む）、`artifacts-sheet.ts`
  - `lightbox.ts`（画像のビューア）、`composer.ts`（入力欄・候補・強調表示・下書き・画像の添付）、`connection.ts`（SSE・replay・再接続・通知）、`viewport.ts`（画面の大きさ・タブの収まり）
- `clientMain` は、store を作り、各モジュールを作って `ctx` でつなぎ、DOM のイベントを登録するだけにする（300 行以下を目安）。各モジュールは 400 行以下を目安にする。超えるならさらに分ける
- 今ある純関数のモジュール（`timeline.ts`・`pending.ts` など）は動かさない
- コードの中身（処理の順序・条件・文言・クラス名）は、移すだけにする。移すときに見つけたバグは直さず、RESULT の issues に書く

## テスト

- 既存のテストがすべて通ること（`src/web/client/*.test.ts`・`src/web/web-page.test.ts`）
- 分けたことで純関数として切り出せたもの（DOM を触らない計算）があれば、テストを足してよい
- 一時の Hub（`pnpm dev serve`。CLAUDE.md の「画面の確認」）で、分ける前と後に同じ操作をして、見た目と動きが同じこと、ブラウザのコンソールのエラーが 0 件であることを確かめる。Agent にはターンを送らない
  - 操作: 画面を開く、会話の一覧・Agent の設定・設定・成果物のシートを開いて閉じる（Tab でのフォーカス）、入力欄で `/` と `@` の候補を出す、`!echo hi` を実行する、画面の幅を PC とスマホ（390px）で切り替える
  - 分ける前と後のスクリーンショット（PC・スマホ、それぞれ同じ画面）を `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存し、パスを RESULT に書く

## 変更してよいファイル

- `src/web/client/client-main.ts`、`src/web/client/index.ts`、`src/web/client/` の新しいモジュールとそのテスト
- `src/web/web-page.ts`（`ClientDeps` の形が変わるときだけ）
- `src/web/web-page.test.ts`（bundle の中の変数名を文字列で探しているテストを、分けた後のモジュールの振る舞いを確かめる形に直す。確かめている内容は減らさない）

## 確認

- `pnpm test`、`pnpm typecheck`、`pnpm build`（成果物の出力先はリポジトリの外の一時フォルダでよい: `node scripts/build-client.mjs <一時>\dist`）が通ること
