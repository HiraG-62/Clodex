# AUTO-RESULT: RESULT を送らずに終えた依頼の最終応答を、依頼元へ自動で届ける

Agent が依頼（DELEGATE など）を受けたターンで、`send_message` の RESULT を使わずに普通の返答で報告して終えると、依頼元の Agent には何も届かない（実際に起きた: codex の PENDING-QUEUE などの報告が claude に届かなかった）。仕様の正は `docs/DESIGN.md` §12「配送ルール」と Message Schema の Coordinator が付与するフィールド（`auto`）。

## 変更

1. **送ったかの記録**（`src/coordinator/coordinator.ts`）
   - `receiveMessage` で、送信元の mailbox が処理中の message（`mailboxes[from].current`）が依頼系で、今回の message の宛先がその依頼の送信元なら、その依頼の ID を「返事あり」として記録する（type は問わない）
2. **自動の RESULT**（`deliver`）
   - `mailbox.enqueue(envelope, { message })` の結果を見て、次をすべて満たせば RESULT を作る
     - 依頼系（`DELEGATE`・`REVIEW_REQUEST`・`QUESTION`）
     - 結果が `completed`、最終応答（`result.text`）が空でない
     - 「返事あり」に記録されていない
     - 割り込みで実行中のターンに足した配送（steer）ではない（今の早期 return の経路なので自然に外れる）
     - 宛先の mailbox が上限で待っていない、閉じていない
   - 作る RESULT: `from` = 依頼の宛先、`to` = 依頼の送信元、`taskId` = 依頼と同じ、`replyTo` = 依頼の ID、`status: "done"`、`body` = 最終応答（`MAX_BODY_LENGTH` を超えたら切り詰めて末尾に `…`）、`auto: true`
   - `createMessage` を通して id などを付ける。`auto` は Agent の入力では受け付けない（schema に入れない。Coordinator が後から付ける）
   - Budget は `this.budget.admit(result, 依頼の message)`。上限ならエラーを人に出して作らない（今の `receiveMessage` の扱いと同じ）
   - `bus.publish({ kind: "message", message })` してから `deliver` で配送する。記録したものは使い終わったら消す
3. **型**（`src/protocol/messages.ts`）: `AgentMessage` に Coordinator が付与する `auto?: true`
4. **envelope**（`src/context/context-resolver.ts`）: `auto` なら本文の前（`Status:` の後など見つけやすい位置）に `Auto: the recipient ended its turn without send_message; this is its final reply.` の 1 行
5. **画面**: Web UI のログの message の行と TUI のカードに、自動で届けたことが分かる小さな印（アイコンか短いラベル。文言を足すなら ja「自動」/ en "auto" 程度）。「この〜」の言い回しは使わない

## テスト方針

- `coordinator.test.ts`
  - DELEGATE を受けた Agent が message を送らずに `completed` で終えると、依頼元へ `auto: true` の RESULT が届く（`replyTo`・`taskId`・`status`・`body`）
  - ターン中に依頼元へ RESULT を送っていたら作らない。QUESTION を送っていても作らない
  - `failed`・`interrupted`・空の最終応答・RESULT や ISSUE を受けたターンでは作らない
  - 長い最終応答は切り詰める
  - Budget の上限なら作らず error
- `messages.test.ts`: Agent の入力の `auto` は無視される（schema が落とす）
- `context-resolver.test.ts`: `auto` の行
- `pnpm test` と `pnpm typecheck`。コミットはしない

## 報告

- 終わったら **`send_message` の RESULT** で報告すること（この機能が入る前なので、普通の返答だけでは claude に届かない）
