# FOLLOWUP-TYPES: 作業中の依頼に続けて送る type（ADD・NOTE・CANCEL）

`FIX`（訂正）だけでは、要件の追加・参考情報・取りやめを送り分けられない。`FIX` と同じ「続きの message」として `ADD`・`NOTE`・`CANCEL` を足す。仕様の正は `docs/DESIGN.md` §11 Message Types・Message Schema（`replyTo`・`spec`・`status`）・`interrupt` の下の「続きの message」の項、§13 Context Resolver の返信方法。今の `FIX` の実装（コミット 56fab6c）を一般化する。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、TUI、Web UI の message のカード、Budget、復旧、テストの fixture など）は確認せずに触ってよい。

1. **schema**（`src/protocol/messages.ts`）: type に `ADD`・`NOTE`・`CANCEL` を足す。4 つとも `replyTo` 必須、`fresh`・`parallel`・`worktree`・`status`・`issues` は不可。`spec` は `FIX`・`ADD`・`NOTE` のみ。`RESULT_STATUSES` に `canceled` を足す。tool の type の説明を 4 つに広げる（"FIX corrects, ADD adds requirements to, NOTE informs about, CANCEL withdraws a DELEGATE / REVIEW_REQUEST you sent (replyTo = that request). Delivered into the recipient's running turn when it is working on it."）
2. **Coordinator**（`src/coordinator/coordinator.ts`）: 今の `FIX` の扱いを、続きの message の集合（例: `FOLLOWUP_TYPES`）に広げる
   - 受け付け: `replyTo` が送信元から宛先への `DELEGATE` / `REVIEW_REQUEST` でなければ拒否（今の FIX と同じ）
   - 配送: 宛先が元の依頼を処理中なら steer。そうでなければ:
     - `FIX` / `ADD` / `NOTE`: 今の session に通常どおり配送
     - `CANCEL`: 元の依頼が配送待ちなら mailbox から外して捨てる（今の `/cancel` の message の取り消しと同じ処理。送信待ちの一覧から消える。CANCEL 自体は宛先に届けない）。配送待ちでも処理中でもなければ受け付けで拒否（"the request is already finished"）
   - 自動の返信: `FIX` / `ADD` を自分のターンとして配送して何も送らずに終えたら、元の依頼への `RESULT`（今の FIX と同じ）。`NOTE` と `CANCEL` は作らない
   - 再送（`RETRIED_TYPES`）: `FIX` / `ADD` は今の FIX と同じ。`NOTE` / `CANCEL` は再送しない
   - Budget: 通常の message として数える
   - 子の会話（`parallel`）で受けた依頼への続きの message は、子の会話へ届ける（今の thread の返信の経路。`replyTo` が親から子へ転送した依頼を指す）
3. **envelope**（`src/context/context-resolver.ts`）
   - `FIX` / `ADD`: 今の FIX と同じ返信方法（元の依頼への RESULT を作業を終えたときに 1 つ）
   - `NOTE`: "No reply is required. Take this into account in the current work."
   - `CANCEL`: "Stop working on this request now. Reply with RESULT, status="canceled", replyTo=<元の依頼>, summarizing what was done and what was left."
4. **役割の定型文**（`src/context/role-instructions.ts`、両 Agent・英語）: 今の FIX の文を、4 つの使い分けに広げる（訂正は FIX、要件の追加は ADD、知らせるだけは NOTE、取りやめは CANCEL。どれも replyTo に元の依頼。新しいタスクは DELEGATE）
5. **画面**: message のカードの type に出る（今の type の表示のまま）。RESULT の status の `canceled` の文言（ja「取りやめ」/ en "Canceled"）
6. 文言は短く

## テスト方針

- schema: 3 つの受け付け、`replyTo` なし・不可のフィールド・`spec` の可否の拒否、status `canceled`
- Coordinator: 処理中なら 3 つとも steer。処理中でないとき `ADD` / `NOTE` は今の session に配送。`CANCEL` は配送待ちの依頼を外し（宛先に届かない）、終えた依頼への CANCEL は拒否。自動の返信は `ADD` だけ（`NOTE` / `CANCEL` は作らない）。子の会話の依頼への続きの message が子へ届く
- envelope・役割の定型文
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
