# SOLO-RELEASE-NOTICE: solo を解除したことを Agent に伝える

solo の間は人の入力の末尾に `[Clodex] Solo mode: do not use send_message. Do all the work yourself.` を足しているが、解除したときは何も伝えていない。会話の履歴に solo の指示が残るので、Agent は解除後も solo のつもりで続け、依頼への報告を `send_message` で返さなかった（実際に codex で起きた）。仕様の正は `docs/DESIGN.md` §11 Solo。

## 変更

1. **保存**（`src/project/conversation-history.ts`）
   - 会話に `soloReleased?: AgentId[]` を足す（schema にも）
   - `setSolo(undefined)`（解除）で、今 solo だったなら `soloReleased` を両方の Agent にする。solo にしたら（`setSolo(mode)`）`soloReleased` を消す
   - 1 Agent 分を外すメソッド（例: `consumeSoloReleased(conversationId, agent): boolean`。入っていたら外して保存し true）
2. **配送の瞬間に足す**（`src/coordinator/agent-mailbox.ts`・`src/coordinator/coordinator.ts`）
   - 末尾の 1 行は今は積むときに `suffix` として決めている。解除の 1 行は「次に届けるもの 1 つだけ」に足したいので、mailbox が Agent に実際に送る直前に呼ぶ hook（例: `deliveryNote?: () => string`。Coordinator が渡す）を足し、返った文字列を本文の末尾に足す
   - 対象は人の入力・formal message の envelope・利用枠の続きの指示・復旧の続きなど、mailbox が Agent に送るすべて（compact と設定用ターンは除く）
   - steer（実行中のターンへの割り込み）で届けるときも足す
   - Coordinator の hook は、今の会話の `soloReleased` にその Agent があれば外して、`\n\n[Clodex] Solo mode is off. Delegate to the other agent with send_message as your role says, and reply to requests with send_message.` を返す。無ければ空文字
   - Coordinator には会話ごとの解除の状態を読む・外す関数を options で渡す（今の `solo?: () => SoloMode | undefined` と同じ形。`project-context.ts` で `history` に繋ぐ）
3. **画面**: 足した 1 行は画面・保存した会話本文・送信待ちの表示には出さない（言語の 1 行と同じ扱い）

## テスト方針

- `conversation-history.test.ts`: 解除で両方入る、solo にすると消える、consume で 1 つずつ外れて保存される、solo でなかった会話の解除では入らない
- `agent-mailbox.test.ts`: hook の文字列が送る本文の末尾に付き、送信待ちの `text` には付かない
- `coordinator.test.ts`
  - 解除後、人の入力 → 1 回目だけ解除の 1 行が付き、2 回目には付かない
  - 解除後の最初の配送が formal message でも付く。Agent ごとに 1 回ずつ
  - Hub の再起動を模して（新しい Coordinator）、残っていればまだ付く
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
