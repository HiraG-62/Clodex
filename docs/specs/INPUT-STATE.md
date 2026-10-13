# INPUT-STATE: 取り消した入力をチャット欄から確実に消し、中断した入力に「中断」を出す

1. 送信待ちの入力を取り消しても、チャット欄に入力が残ることがある（人の報告。CANCEL-HIDE・コミット 420885f で、取り消しの event でログから消すようにしたはずが、どこかの経路で効いていない）
2. 送った入力を Agent が処理している途中で中断（`/interrupt`・Ctrl+C・中断のボタン）しても、入力の発言には何も出ず、中断したことが分からない

仕様の正は `docs/DESIGN.md` §17 ログの「人間の入力の発言には…『中断』の印」と、§28「送信の取り消し・編集」。

## 1. 取り消し（調査と修正）

対象のファイルは目安（`src/coordinator/coordinator.ts` の `cancelInput`、`src/web/web-ui.ts`・`web-feed.ts`・`feed-store.ts`、`src/web/client/timeline.ts`・`connection.ts`・`pending-view.ts`、TUI）。同じ目的に要るファイルは確認せずに触ってよい。

- 残る経路を、再現して見つける。疑わしいもの:
  - Web UI の送信待ちの「取り消し」「編集」（`/cancel <id>`）と、CLI の `/cancel`（ID 省略）
  - `@all` の入力（Agent ごとに 1 件ずつ積む。ID が別々）・`/context` の入力・画像付きの入力
  - 送った画面と別の画面（スマホと PC）、読み込み直した後（保存した feed から）、裏の会話
  - 画面が送った直後に自分で出している表示（あれば）と、`human` event の `inputId` の結び付き
  - 前の版で保存した、`inputId` の無い `human` event
- 見つけた経路を直し、再現テストを足す。どの経路だったかを RESULT に書く

## 2. 中断の表示

- 人間の入力の発言に「中断」の印（ja「中断」/ en "Interrupted"。今の「割り込み」の印と同じ置き方）を付ける条件: その入力を処理したターン（mailbox がその入力を配送して始まったターン）が `interrupted` で終わった。割り込み（steer）で足した入力は、足した先のターンが `interrupted` で終わった
- 結び付け: Coordinator がターンの終わりに、そのターンで処理した人間の入力の `inputId`（steer なら `steerId` か `inputId`）を event に載せる（例: `{ kind: "input_interrupted", inputIds }`、または `turn` event に付ける）。保存した feed の再生でも同じ印になる
- 配送前に `/interrupt` しても人間の入力は送信待ちに残る（今どおり）ので、印は付けない
- TUI も同じ印（例: `中断`）

## テスト方針

- 取り消し: 見つけた経路の再現テスト（timeline・feed の保存・読み込み直し）
- 中断: Coordinator が中断で終わったターンの入力の ID を出す。timeline が該当の発言に印を付ける（steer の入力も）。完了したターンには付かない。保存した feed の再生でも付く
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、取り消した入力が消えていること、中断した入力の印のスクリーンショットを撮って RESULT に path を書く（feed の流し込みでよい）
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
