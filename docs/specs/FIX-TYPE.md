# FIX-TYPE: 作業中の依頼を訂正する message の type `FIX`

`.clodex.json` の `freshThread` で `DELEGATE` を新しい session にする設定にすると、作業中の相手に訂正を `DELEGATE` + `interrupt: true` で送っても、新しい session の依頼として配送待ちに回り、割り込めない（スクリーンショット: `C:/Users/Horry/.clodex/uploads/E--dev-Clodex-ce95cf0d/20261012T104454-043f64a9.png`）。新しいタスクの `DELEGATE` と、送った依頼の訂正を別の type に分ける。仕様の正は `docs/DESIGN.md` §11 Message Types・Message Schema・`interrupt` の下の `FIX` の項、§13 Context Resolver の `FIX` の返信方法。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、TUI、Web UI の message のカード、Budget、復旧、テストの fixture など）は確認せずに触ってよい。

1. **schema**（`src/protocol/messages.ts`）: type に `FIX` を足す。`replyTo` 必須。`spec`・`files`・`commit` を許す。`status`・`issues`・`fresh`・`parallel`・`worktree` は不可。tool の説明: "FIX corrects or adds to a DELEGATE / REVIEW_REQUEST you sent (replyTo = that request). Delivered into the recipient's running turn when it is working on it."
2. **Coordinator**（`src/coordinator/coordinator.ts`）
   - 受け付け: `replyTo` が、送信元が宛先へ送った `DELEGATE` / `REVIEW_REQUEST` でなければ拒否（英語のエラー）
   - 配送: 宛先が訂正する依頼を処理中（`mailbox.current` がその依頼。依頼の chain の中の FIX を処理中も含めてよい）なら、`interrupt` の指定によらず steer する（今の割り込みの message と同じ経路・印）。処理中でなければ通常どおり mailbox に積む（`fresh` にしない）
   - 自動の返信: FIX を自分のターンとして配送して、宛先が送信元へ何も送らずにターンを終えたら、最終応答を `RESULT`（`replyTo` は元の依頼の ID）として返す（今の自動の RESULT と同じ扱い）。steer したときは作らない（元の依頼のターンの返信に含まれる）
   - Budget: 通常の message として数える（委譲の回数には数えない）
   - **`freshThread` の既定**: `interrupt: true` の message には当てない（今の FRESH-THREAD の実装で、設定の既定で `fresh` になった message が steer されず配送待ちに回っていた）
3. **envelope**（`src/context/context-resolver.ts`）: FIX の返信方法は `type="RESULT"`、`replyTo` は元の依頼の ID、「Send RESULT once when the corrected work is complete」。`spec` があれば今の依頼と同じ 1 行
4. **役割の定型文**（`src/context/role-instructions.ts`、両 Agent・英語）: 今の `interrupt` の文を、「相手が作業中の、自分が頼んだ依頼を直したり付け足したりするときは、`FIX`（`replyTo` は元の依頼）で送る。新しいタスクは `DELEGATE`」に置き換える
5. **画面**: message のカードの type に `FIX` が出る（今の type の表示のまま）。steer したら今の「割り込み」の印
6. 文言は短く

## テスト方針

- schema: FIX の受け付け、`replyTo` なし・不可のフィールドの拒否
- Coordinator: 自分が送った依頼でない `replyTo` の拒否。宛先がその依頼を処理中なら steer（`interrupt` なしでも、`freshThread` が DELEGATE で true でも）。処理中でなければ今の session に配送（新しい session にならない）。自分のターンとして処理して終えたら元の依頼への自動の RESULT。`interrupt: true` の DELEGATE に `freshThread` の既定が当たらない
- envelope・役割の定型文
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
