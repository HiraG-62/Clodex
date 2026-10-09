# NOTIFY-FORMAT: 通知の形式を統一する

今は、今の会話の通知（画面が `updateDesktopNotify` で作る GUI の Windows 通知、Hub が同じ関数で作る Web Push）は最終応答の 1 行目を本文にし、裏の会話・ほかの project の通知（`Workspace.handleEvent` → toast・`backgroundPushPayload`）は短い文にしている。これを Hub の 1 か所で作り、すべて同じ形式にする。仕様の正は `docs/DESIGN.md` §28「通知の形式」。

## 形式

- タイトル: `Clodex【<project 名>】「<会話名>」`（project 名は project root のフォルダ名。会話名が無ければ `web.conv.untitled`）
- 本文: `<内容>（<Agent 名>）`。Agent 名は `Claude` / `Codex`。英語も同じ形（括弧は半角でよい: `Work finished. (Claude)`）
- 内容（文言は `src/i18n/messages.ts` に ja / en で足す）

| 種類 | ja | en |
|---|---|---|
| ターンが completed、そのターンで tool を使った | 作業完了しました。 | Work finished. |
| ターンが completed、tool を使わず返答だけ | 応答しました。 | Replied. |
| failed | 失敗しました。 | Failed. |
| interrupted | 中断しました。 | Interrupted. |
| 人への質問（`ask_user`） | ユーザの回答待ちです。 | Waiting for your answer. |
| 利用枠の上限で止まった | 利用枠の上限で停止しました。再開 {time}。 | Stopped at usage limit. Resumes {time}. |
| Agent のエラー | エラー: {line} | Error: {line} |
| Agent に関係しない notice | notice の本文のまま（Agent 名を付けない） | 同じ |

## 変更

1. **通知を作る純粋な関数**（例: `src/hub/notify-format.ts`。i18n の messages を引数に取る）: 種類・project 名・会話名・Agent から `{ title, body }` を作る。tool を使ったかは呼び出し側が渡す
2. **Hub が通知を作る**（`src/index.ts`・`src/hub/workspace.ts`・`src/hub/project-context.ts`）
   - feed に `notify` の項目（`{ type: "notify", notification: { kind, project, conversation, agent?, title, body } }`。型は `src/web/web-feed.ts`）を足し、Hub が publish する。保存（feed の履歴）には入れない（再生で通知しないため）
   - 今の会話: 今の `updateDesktopNotify` の判定（どの Agent も作業中でなく配送待ちも無くなったら、最後に終わったターンで 1 回）を Hub 側で行う。tool を使ったかは、そのターンの `tool` event の有無で決める（状態に持つ）。質問・notice・error も今の判定のまま `notify` にする
   - 裏の会話・ほかの project: `Workspace.handleEvent` のターン終了（tool の有無を覚えておく）と質問で `notify` を作る。画面の toast もこの `title`・`body` から作る（toast の文は `<title> <body>` か本文の前にタイトルを付けた形。長ければ画面の toast の今の扱いで省略される）
   - 利用枠の上限の notice（`notice.limitHold`）は、どの会話か分かるので「利用枠の上限で停止しました」の形にする。分からない notice はそのまま
   - Web Push: `notify` のうちターンの終わり（作業完了・応答・失敗・中断）と質問だけを、`title`・`body` のまま送る（`backgroundPushPayload` は消すか置き換える）
3. **画面**（`src/web/client/client-main.ts`・`desktop-notify.ts`）
   - GUI の Windows 通知は、feed の `notify` の項目をそのまま出す（ウィンドウが見えていないかフォーカスが無いとき、という今の条件のまま）。画面で通知を作る処理（`updateDesktopNotify` の画面側の使い方）は消す
   - `updateDesktopNotify` を Hub 側の判定に使い回すなら残してよいが、出力は新しい形式にする
4. 不要になった文言（`desktop.notify.finished`、`notice.background`、`notice.backgroundQuestion`、`notice.backgroundProject` など）は、使わなくなったら消す

## テスト方針

- 通知を作る関数のテスト: 表の各種類の ja / en、会話名なし、notice（Agent 名なし）
- 今の会話の判定: 作業中 → 全員止まったで 1 回、tool の有無で作業完了 / 応答、失敗・中断、質問。再生では出さない（`desktop-notify.test.ts` を Hub 側の判定に合わせて書き直す）
- `workspace.test.ts`: 裏の会話・ほかの project のターン終了と質問で、新しい形式の `notify` になる
- Web Push に送る種類の絞り込み
- `pnpm test` と `pnpm typecheck`。コミットはしない。画面の確認は CLAUDE.md / AGENTS.md の手順（GUI の Windows 通知そのものは確かめにくいので、`notify` の項目が feed に流れることを確かめれば足りる）。終わったら `send_message` の RESULT で報告する
