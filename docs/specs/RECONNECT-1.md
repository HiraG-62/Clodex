# RECONNECT-1: 再接続で履歴と位置を失わない・TUI が黙って止まらない・ログを読み上げ続けない

独立した 3 件。コミットは件ごとに分けるので、RESULT では件ごとに変更したファイルを書く。仕様は docs/DESIGN.md §17 Web UI の「待ちの表示」「使い勝手の決まり」（今回追記済み）。

## A. Web UI: 再接続で上に読み足した履歴が消え、スクロール位置が飛ぶ

現状: `src/web/client/client-main.ts` の `connect` は、接続のたびに `onopen` で replay を始め、`commitReplay` で `history = incomingHistory`（Hub が送る直近の分）に置き換える。上にスクロールして `/api/history` で読み足した古い履歴が消え、`opened`（開いた details）も消え、読み返していた位置が飛ぶ。tailscale 経由のスマホでは、アプリをバックグラウンドから戻すたびに起きうる。

変更:
- `commitReplay` で、受け取った履歴が今の履歴と同じ流れの続きなら、受け取った最古の `seq` より前の今の履歴を残して先頭につなぐ。`historyHasMore` もそのときは今の値を保つ
  - 同じ流れの判定: 受け取った最古の項目と同じ `seq` の項目が今の履歴にあり、`type` と中身（event なら `event.kind` と `event.at`、output なら `text` の先頭）が一致する。一致しなければ（会話の切り替え、Hub の再起動で seq が振り直された）今どおり置き換える
  - 判定は純関数にして `src/web/client/timeline.ts`（か近い既存のモジュール）に置き、テストを書く
- 読み返している最中（一番下にいない）なら、再接続の前に見ていた項目が同じ位置に見えるよう、スクロール位置を保つ。一番下にいたら今どおり一番下
  - 既存の「上に読み足したときに位置を保つ」処理があれば、それを使う
- `opened` は、残した項目の分を消さない

テスト: 判定の純関数（同じ流れ / 会話の切り替え / seq の振り直し / 受け取った履歴が空）。DOM のスクロール位置は手で確かめ、結果を RESULT に書く（一時の Hub で、上に読み足してから Hub への接続を切って戻す。手順は CLAUDE.md の「画面の確認」。`pnpm dev serve` で動く）

## B. TUI: Hub との接続が切れても黙って止まる

現状: `src/tui/feed-client.ts` の `createRemoteFeedClient.connect` は、SSE の stream が終わる（`done`）か例外になると、読み取りのループを黙って終える。`src/tui/tui.ts` がエラーを出すのは最初の接続に失敗したときだけなので、Hub を再起動すると TUI は無言で止まる。

変更:
- remote の client は、stream が終わったり失敗したりしたら（自分で `stop` したときを除く）、間隔を伸ばしながら接続し直す（1 秒から倍にして最大 30 秒。定数にする）。成功したら間隔を戻す
- 切れたこと・つながったことを TUI に伝える。`FeedClient` の `connect` に接続状態の callback を足すか、`onItem` に TUI 専用の項目を流すかは、TUI の今の構造に合う方でよい（`FeedItem` は Hub と共有の型なので、TUI 専用の項目を足すなら `FeedItem` ではなく client の側の型にする）
- TUI は切れている間、通知の行に「再接続中…」を出し続ける（4 秒で消さない）。つながったら消す
- 接続し直したら、Hub は最初の接続と同じく直近の履歴と `state` を送り直すので、TUI は `reset` と同じく履歴を空にしてから受け取る（重複して表示しない）
- local の client（Hub と同じプロセス）は切れないので変えない
- 文言は `src/i18n/messages.ts` に ja / en を足す（「再接続中…」/ "Reconnecting…"）

テスト: fake の fetch（または注入した接続の関数）で、stream が終わったら再接続し、間隔が伸びること（fake timer）。`stop` の後は再接続しないこと。TUI が切断中に「再接続中…」を出し、つながったら消すこと。

## C. Web UI: ログ全体が `aria-live` で読み上げ続ける

現状: `src/web/web-page.ts` の `#log` に `aria-live` が付いている。ログの中の経過時間が毎秒書き換わり、作業中のターンも丸ごと描き直すので、スクリーンリーダーが読み上げ続ける。

変更:
- `#log` から `aria-live` を外す
- 画面に出さない読み上げ用の領域（`aria-live="polite"`、visually hidden のクラス）を 1 つ置き、ターンの完了（Agent 名と完了・中断・失敗）と、人への質問が届いたときだけ、短い文をそこに入れる。文言は既存の通知（`notify`）の本文があれば、それを使う
- 既存の visually hidden のクラスがあればそれを使う

テスト: `src/web/web-page.test.ts` で、`#log` に `aria-live` が無く、読み上げ用の領域があること。どの event で文を入れるかは、純関数にできるならそこをテストする

## 変更してよいファイル

- `src/web/client/client-main.ts`、`src/web/client/timeline.ts`（と、そのテスト）、新しい `src/web/client/*.ts`
- `src/web/web-page.ts`、`src/web/web-page.test.ts`
- `src/tui/feed-client.ts`、`src/tui/tui.ts`、`src/tui/*.test.ts`
- `src/i18n/messages.ts`

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
