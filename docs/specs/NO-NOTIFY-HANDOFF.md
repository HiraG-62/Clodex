# NO-NOTIFY-HANDOFF: Agent 同士のやり取りの途中のターンでは通知しない

Agent 同士の DELEGATE・QUESTION・RESULT のやり取りのたびに、ターンの終わりの通知（GUI の Windows 通知・Web Push・toast）が出る。人が見る必要があるのはやり取りの終わり（人への報告）と人への質問だけなので、途中のターンでは出さない。仕様の正は `docs/DESIGN.md` §28「通知の形式」の「Agent 同士のやり取りの途中のターンでは」。

## 途中のターン

- 相手からの依頼（`DELEGATE`・`QUESTION`・`REVIEW_REQUEST`）を処理したターン（mailbox がその message を配送したターン。割り込み（steer）で実行中のターンに足した依頼は、そのターンを途中にしない）
- ターンの中で相手に formal message（`ACK` を除く）を送ったターン
- Coordinator が最終応答から自動の `RESULT` を作ったターン（上の 1 つ目に含まれるはずだが、念のため）

相手の `RESULT` や `ISSUE` を受けたターンは、そのターンで新しく message を送らなければ途中ではない（人に報告して終えるターン）。人の入力・続きの指示（利用枠・再起動）で始まったターンも、message を送らなければ途中ではない。Agent が自分から始めたターン（spontaneous）も同じ。

## 変更

1. **Coordinator**（`src/coordinator/coordinator.ts`）
   - Agent ごとに「今のターンが途中か」を持つ。ターンの開始（`turn_started`）で初期化し、mailbox が依頼系の message を配送して始めたターンなら途中にする（`mailbox.current` の type で判定）。`receiveMessage` でその Agent が送信元なら途中にする
   - `turn` event を bus に publish するとき、途中なら印を付ける（例: `CoordinatorEvent` の `agent` に `handoff?: true` を足す。adapter の event の型は変えない）
2. **Hub の通知**（`src/hub/workspace.ts`、`src/index.ts`、`src/web/client/desktop-notify.ts` の判定。今どこで `notify` を作っているかに合わせる）
   - 裏の会話・ほかの project: 印のある `turn` では `notify` を作らない（toast・Web Push・Windows 通知のどれも出ない）
   - 今の会話: 「どの Agent も作業中でなく配送待ちも無い」で出すとき、最後に終わったターンに印があれば出さない
   - 質問（`ask_user`）・利用枠の上限・エラーは今どおり
3. 文言は変えない

## テスト方針

- `coordinator.test.ts`: DELEGATE を処理したターン、send_message を送ったターン、自動の RESULT のターンに印が付く。RESULT を受けて報告だけのターン、人の入力のターンには付かない
- `workspace.test.ts`: 裏の会話で印のあるターンは notify しない、無いターンはする
- 今の会話の判定のテスト（`desktop-notify.test.ts` など）: 最後のターンに印があれば出さない
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
