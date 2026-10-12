# TOKEN-ROTATE: スマホ用の URL（Web の token）を再発行する

スマホで開く URL（`?token=` 付き）と QR コードが漏れたときに、発行し直して、前の URL と、それで入った端末を使えなくする。今は token が `~/.clodex/web-token` に固定で、変えるにはファイルを消して Hub を起動し直すしかない。仕様の正は `docs/DESIGN.md` §17 Web UI の「token の再発行」。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、GUI の Rust・capability、TUI の feed client、テストの fixture など）は確認せずに触ってよい。

1. **token**（`src/web/web-token.ts`）: 新しい token を作って `~/.clodex/web-token` に書く関数（一時ファイル経由で置き換える。今の生成と同じ乱数と長さ）
2. **Hub**（`src/web/web-server.ts`・`src/index.ts`）
   - 認証に使う token を入れ替えられるようにする（今は起動時の値を閉じ込めているはず）
   - `POST /api/connect/rotate`（token 認証）: 新しい token を書いて入れ替え、今つながっている feed（SSE）をすべて閉じ、応答に新しい token の cookie（`Set-Cookie`。今の属性と同じ）を付けて、`GET /api/connect` と同じ中身（新しい URL と QR コード）を返す
   - 前の token の cookie・`?token=` は以後 401
   - Web Push の購読は消さない
3. **Web UI**（設定の「スマホ」の行、`src/web/client/` の接続の案内のシート）
   - 「再発行」のボタン（ja「再発行」/ en "Reissue"）。押すと確認（ja「今の URL とログイン中の端末は使えなくなる」/ en 同じ方針）を出し、OK なら `POST /api/connect/rotate`。成功したら新しい URL と QR コードを表示する
   - 再発行した画面の feed は閉じられるので、今の再接続の仕組みで新しい cookie でつなぎ直す（その画面はそのまま使える）
   - ほかの画面: 再接続が 401 になったら、再接続を繰り返さず「新しい URL で開き直す」状態（ja「接続できません。新しい URL で開き直す」など短く）を出す
4. **GUI**（`gui/src-tauri`、`src/web/client/gui-push.ts` の GUI の command の呼び出し）: GUI の中の Web UI が 401 を受けたら、GUI の command で `~/.clodex/web-token` を読み直し、`<url>/?token=<新しい token>` でページを開き直す（GUI は Hub と同じ PC にいるので）。command が無い（ブラウザ）なら 3 の表示
5. **TUI**（`src/tui/feed-client.ts`）: 401 を受けたら `~/.clodex/web-token` を読み直して 1 回だけつなぎ直す。それでも 401 なら今のエラーの表示
6. 文言は短く。「この〜」の言い回しは使わない

## テスト方針

- token: 書き直すと別の値になり、ファイルが置き換わる
- `web-server.test.ts`: rotate の後、前の token の cookie と `?token=` が 401、新しい cookie が通る。rotate の応答に `Set-Cookie` と URL がある。今つながっている SSE が閉じる。token なしの rotate は 401
- TUI の feed client: 401 で読み直して 1 回つなぎ直す
- Web UI: 401 の再接続で「開き直す」状態になる（再接続を繰り返さない）
- Rust: `cargo test`（`gui/src-tauri`）が通ること
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で（一時の `CLODEX_HOME` なので本物の `~/.clodex/web-token` には触れない）、再発行の確認・再発行後の URL と QR コード・別のタブ（前の cookie）での「開き直す」状態のスクリーンショットを撮って RESULT に path を書く
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
