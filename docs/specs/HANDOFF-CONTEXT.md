# HANDOFF-CONTEXT: 人の判断の共有・上限での引き継ぎ・再起動の続き

roguelike での運用からの改善案（2・3・4）。仕様の正は `docs/DESIGN.md` の §13（人の入力の末尾の行の続き）、§14「上限での停止と自動再開」、§18「Hub の再起動からの復旧」。

## 2. 人の判断をもう片方にも添える

- Coordinator は Agent ごとに「相手の Agent に届いた人の発言」のたまりを持つ
  - 人の入力（`sendToAgent`・`steerOrSend`）を Agent A に送ったら、B のたまりに `{ to: A, text }` を足す。`@all`（両方に送る）は足さない（shell が両方に `sendToAgent` するので、同じ本文が両方に来た場合は足さない仕組みが要る。例: `sendToAgent` に「両方へ」の印を渡すか、shell が sendAll のとき印を付ける）
  - A の質問への回答（`answer`）も、B のたまりに `{ to: A, text: <質問の見出し>: <回答> }` として足す
- 配送の瞬間に足す（SOLO-RELEASE-NOTICE で入れた `deliveryNote` の hook と steer の経路に相乗りする）
  - たまりがあれば `\n\n[Clodex] Since your last turn, the human said to <A>:\n- <300 文字まで>…` を足し、たまりを空にする。最大 5 件、超えた分は `- (+N more)`
  - 画面・保存した本文・送信待ちには出さない
- 保存しない

## 3. 上限で止まったときの引き継ぎ

- Coordinator は Agent ごとに、今のターン（`turn_started` から `turn` まで）の方針（最初の `text` の 1 行目）と編集したファイル（`tool` event の `files`）を覚える
- 上限で hold を始めたとき（mailbox 経由・spontaneous の両方。`limitHold` が hold を返した経路）、相手の Agent に知らせる
  - 文: `[Clodex] <agent> hit its usage limit and resumes at <時刻>. Its last plan: <方針>. Files it edited in its last turn: <a, b>. Do not edit these files until it resumes.`（方針・ファイルが無ければその文を省く）
  - 相手が busy なら `steer` で今のターンに足す。steer できなければ、相手の次の配送の末尾に添える（2 と同じ hook。保存しない）
  - solo のとき、相手が `stopped` のときは知らせない
- hold を始めた時刻から再開までの間に、相手の Agent の `tool` event に出た `files` を集め、再開の続きの指示（`LIMIT_CONTINUE`）の末尾に `While you were stopped, <peer> edited: <ファイル>. Check them before continuing.` を添える。無ければ添えない
- ファイルのロックは作らない

## 4. 再起動の続きに直前の作業を添える

- 復旧の状態（`.recovery.json`、`src/project/recovery-store.ts`）の会話ごとに `lastWork?: Partial<Record<AgentId, { plan?: string; actions: string[] }>>` を足す。`actions` は直近の tool 呼び出し（`<name> <input の要約>`）を 5 件まで
- Coordinator は 3 で覚えている今のターンの方針と tool から、作業中の Agent の `lastWork` を recovery の状態に出す（今の `recoveryState()` に足す。ターンの開始・tool・終了で書き直される既存の仕組みに乗る）
- 復旧で `RECOVERY_CONTINUE` を送るとき、`lastWork` があれば `\nBefore the restart you were: <plan>. Last actions:\n- <action>…` を添える

## テスト方針

- `coordinator.test.ts`
  - 2: A に人の入力 → B への次の配送の末尾に添えられ、その次には付かない。`@all` は付かない。回答も付く。6 件以上で `+N more`。steer でも付く
  - 3: 上限の hold で、相手が busy なら steer に知らせが入り、idle なら次の配送に付く。方針・ファイルの有無で文が変わる。solo・相手 stopped では知らせない。hold 中の相手の編集ファイルが続きの指示に付く
  - 4: `recoveryState()` に `lastWork` が出る（方針・最後の 5 件）。復旧した Coordinator の続きの指示に付く
- `recovery-store.test.ts`: `lastWork` の保存と読み込み（壊れた値は無視）
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する。一時ファイルはリポジトリの外に置く
