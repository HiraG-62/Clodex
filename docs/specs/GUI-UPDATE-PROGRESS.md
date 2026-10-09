# GUI-UPDATE-PROGRESS: 更新の進み具合を出し、更新のボタンを 1 つにまとめる

設定画面の「Clodex」の節は、「更新を確認」と、更新があるときだけ出る「更新」の 2 つのボタンがある。押した後は「更新中…」のままダウンロード（約 57 MB）が終わるまで何も変わらず、止まって見える（実際に、動かないと思われた）。ダウンロードの割合を出し、ボタンを 1 つにする。仕様の正は `docs/DESIGN.md` §28「Web UI の設定からの更新」。

## 変更

1. **GUI（Rust）**（`gui/src-tauri/src/update.rs`、command の定義）
   - `install_update` に進み具合を返す channel（`tauri::ipc::Channel`）の引数を足す。`update.download` の chunk の callback で、受け取った量の合計と全体の大きさ（`content_length`。無ければ送らない）から割合（0〜100 の整数）を求め、前に送った値から変わったときだけ送る
   - 外部 URL の画面から command を呼ぶ ACL（`build.rs` の `AppManifest`・capability）は今のものを使う。channel のために許可が要るなら足す
   - トレイからの更新（ダイアログで聞く方）は今のまま（進み具合は出さなくてよい）
2. **GUI の中の Web UI**（`src/web/client/gui-push.ts` の `runGuiCommand`）
   - `install_update` に channel を渡し、割合が前に Hub へ送った値から 5 以上変わったら（と 100 のとき）`POST /api/gui/status` で `{ status: "installing", progress }` を送る
3. **Hub**（`src/web/web-feed.ts` の `GuiUpdate`、`src/web/web-server.ts`）
   - `installing` に `progress?: number` を足す。`/api/gui/status` で受け取って、今どおり全画面に送る（値の検証: 0〜100 の整数）
4. **画面**（`src/web/client/gui-push.ts` の `guiUpdateSection` / `refreshGuiUpdate`、`src/i18n/messages.ts`）
   - ボタンを 1 つにし、状態で文言と動きを変える
     - 未確認・`latest`・`error`: 「更新を確認」（`check`）。`latest` は版の横に「最新版」、`error` は「失敗: <message>」を小さく出す
     - `checking`: 「確認中…」（押せない）
     - `available`: 「更新 <version>」（`install`。今の確認のダイアログの後に送る）
     - `installing`: 「更新中… <progress>%」（押せない。`progress` が無ければ「更新中…」）
   - 使わなくなった文言（「<version> あり」など）は消す。文言は短く（UI 文言の方針）

## テスト方針

- ボタンの文言・動き（`check` / `install` / 押せない）を状態から決める部分を純粋な関数にしてテストする（各状態、`progress` の有無）
- Hub: `/api/gui/status` の `installing` の `progress` を受け取り、範囲外を拒否する（`web-server.test.ts`）
- 割合の間引き（5 以上の変化と 100）を純粋な関数にできるならテストする
- Rust: `cargo test`（`gui/src-tauri`）が通ること。割合の計算を関数に分けてテストできるならする
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、GUI の状態を feed に差し込み、各状態のボタンのスクリーンショットを撮って RESULT に path を書く（実際の更新はしない）
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
