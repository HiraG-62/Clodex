# チャットの表示の修正 3 件

`docs/DESIGN.md` §17 Web UI（feed・画面）、§18 Web UI の feed、§28 D1・D3 通知を更新済み。3 件は互いに独立しているので、この順で 1 件ずつ仕上げて RESULT は最後にまとめてよい。

## 1. 会話の操作結果・ほかの会話の完了を `toast` にする

問題: `/resume` の「切り替えました」や、ほかの会話の「ターンが終わりました」が `output` / `notice` としてログに入り、会話の feed に保存される。

変更:

- `FeedItem` に `{ type: "toast"; text: string; level: "info" | "warn" }` を足す（`src/web/web-feed.ts`）。`WebFeed.publishToast(text, level)` は購読者に配るだけで、`items` にも `onRecord` にも入れない（保存しない・再接続で再送しない）
- Shell（`src/cli/shell.ts`）の依存に `notify(text: string, level?: "info" | "warn")` を足し、次の出力を `print` から `notify` に替える
  - `shell.newConversation` / `shell.newWorktree` / `shell.resumed` / `shell.renamed` / `shell.deleted`（と `remove()` が返す失敗）/ `shell.pinned` / `shell.unpinned` / `shell.projectOpened`、`notice.sameDirBusy`（`warn`）
  - 引数なしの `/resume`・`/project` の一覧表示はコマンドの出力なので `print` のまま
- `Workspace.handleEvent` の裏の会話の完了は、今の会話の bus に `notice` を publish せず、`WorkspaceOptions` に足す `notify(text, level)` で知らせる。`status` が `completed` 以外なら `warn`
- `src/index.ts`: `notify` は `feed.publishToast` と、TUI でない terminal への 1 行の表示（`printTerminal`）。ProjectContext / Workspace への `notify` も同じものを渡す
- Web UI（`src/web/client/client-main.ts`、CSS は `src/web/web-page.ts`）: 上部中央（PC は右上）に重ねて出し、4 秒（定数）で消す。押すと消す。最大 3 件（古いものから消す）。`warn` は警告色。`timeline.ts` の `applyFeedItem` は `toast` を無視する
- `desktop-notify.ts`: `toast` もデスクトップ通知の対象にする（`notice` と同じ扱い。タイトルは今の `desktop.notify.notice`）
- TUI（`src/tui/tui.ts`）: 既存の `notice` の行に 4 秒出す
- i18n の文言（`notice.background` 等）は今のまま使ってよい

テスト: `WebFeed.publishToast` が購読者に届き `recent()` と `onRecord` に入らないこと、Shell の各操作が `notify` を呼び `print` を呼ばないこと、Workspace が裏の会話の完了で `notify` を呼び今の会話の bus に `notice` を出さないこと、`applyFeedItem` が `toast` で項目を変えないこと、desktop-notify の `toast`。

## 2. 会話を切り替えて戻ると、作業中のターンが中断扱いになる

原因: `FeedStore.load()` の `interruptUnfinished` が、`turn` の無いターンに必ず `interrupted` の `turn` を足す。裏で作業中の会話に切り替えて戻ると、まだ動いているターンが中断として表示され、その後の event は別のターンとして出る。

変更:

- `FeedStore.load(conversationId, working: ReadonlySet<AgentId> = new Set())`。`working` の Agent の未完了のターンには `interrupted` を足さない
- 呼び出し側（`src/web/conversation-feed.ts` の `connectConversationFeed`、`src/hub/project-context.ts` の `showFeed`）は、その会話の runtime の `coordinator.status()` で `busy` / `starting` の Agent を渡す。runtime が無い会話（保存のみ・Hub の起動直後）は空集合（今どおり中断扱い）
  - `connectConversationFeed` の `HistorySource` / 引数に「会話 ID → 作業中の Agent」を引く関数を足す形でよい

テスト: 作業中の Agent を渡すと未完了のターンがそのまま残り、渡さない Agent は `interrupted` になること。`connectConversationFeed` が切り替え先の作業中の Agent を `load` に渡すこと。

## 3. 履歴を少しずつ読み込む

問題: 接続時と会話の切り替え時に直近 1,000 件をすべて送り、画面がすべてを描くので、長い会話は開くのが遅い。

変更（定数は `src/web/web-feed.ts` に置く）:

- `INITIAL_HISTORY_ITEMS = 200`、`HISTORY_PAGE_ITEMS = 200`。メモリに持つのは今どおり `DEFAULT_RECENT_ITEMS`（1,000）
- `WebFeed`:
  - `recent()` は直近 `INITIAL_HISTORY_ITEMS` 件だけを返す
  - `replace()` は `reset` の後、直近 `INITIAL_HISTORY_ITEMS` 件だけを配る（メモリには `limit` 件持つ）
  - `before(seq: number, limit = HISTORY_PAGE_ITEMS): { items: HistoryItem[]; hasMore: boolean }` を足す。通し番号が `seq` より小さい項目の直近 `limit` 件（`limit` は 1〜`HISTORY_PAGE_ITEMS` に収める）
- `web-server.ts`: `GET /api/history?before=<seq>&limit=<n>`（認証あり）で `feed.before()` を JSON で返す。`before` が数でなければ 400
- `FeedClient`（`src/tui/feed-client.ts`）に `history(before: number): Promise<{ items; hasMore }>` を足す。local は `feed.before`、remote は `/api/history`
- 画面（`client-main.ts`）:
  - 受け取った `event` / `output` を生の配列でも持つ。ログ（`TimelineItem[]`）は今どおり `applyFeedItem` で積み上げる
  - ログの一番上から 200px（定数）以内までスクロールしたら、持っている最も古い `seq` で `/api/history` を読む。読み込み中は重ねて読まない。`hasMore` が false なら以後は読まない
  - 受け取ったら生の配列の前に足し、全体を `applyFeedItem` で組み立て直して描き直す。描き直した後、`scrollHeight` の増分だけ `scrollTop` を足して見ている位置を保つ
  - `reset` と再接続（`version` を受け取ったとき）で生の配列・`hasMore`・読み込み中の印を初期化する。読み込み中に初期化したら、その応答は捨てる（世代の番号で見分ける）
  - 項目の描画は、組み立て直しても内容が同じ項目（`id` と中身が同じ）は前の DOM を使い回せるなら使い回す。難しければ全体を描き直してよい（200 件単位なので許容）
- TUI（`tui.ts`）: スクロールの位置が上限（一番上）に達したら同じく `client.history()` で前を読み、生の配列の前に足して組み立て直す。足した行数ぶん位置を足して見ている内容を動かさない

テスト: `WebFeed.recent()` / `replace()` が直近 200 件だけを配ること、`before()` の範囲・`hasMore`・`limit` の上下限、`/api/history` の応答と 400・401、local の `FeedClient.history`。画面のスクロール位置の維持はテストしにくいので、組み立て直しの純関数（生の配列 → `TimelineItem[]`）を切り出してテストする。

## 確認

- `pnpm test`、`pnpm typecheck`
- Web UI の起動処理と表示を変えるので、`src/acceptance.e2e.test.ts` は claude が人の了承を取ってから実行する（codex は実行しない）
