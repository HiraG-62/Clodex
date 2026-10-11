# PENDING-STEER: 送信待ちの項目を割り込みで送る

送信待ちの一覧には「編集」「取り消し」しかなく、作業中の Agent にすぐ伝えたいときは、取り消して `@<agent>!` で打ち直すしかない。各行に「割り込み」を足し、その項目を実行中のターンに steer する。仕様の正は `docs/DESIGN.md` §「コマンド」の `/steer <id>` と §28 v0.3 C「割り込み（steer）」の「送信待ちから」。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、help の一覧、入力の候補、TUI など）は確認せずに触ってよい。

1. **入力**（`src/cli/input.ts`・`commands.ts`）: `/steer <id>` を足す。id は送信待ちの人間の入力（`in…`）か formal message（`msg_…`）。引数の候補は `/cancel` と同じく送信待ちの ID
2. **Coordinator**（`src/coordinator/coordinator.ts`・`agent-mailbox.ts`）: `steerQueued(id)` のような処理
   - 宛先が実行中（`busy`）で、利用枠の上限で待っていなければ、項目を mailbox から外して steer する
     - 人間の入力: `@<agent>!` と同じ経路（言語の 1 行・`/context` の指示・画像など、配送のときに足すものは今の steer と同じに付ける）。新しい `human` event は出さず、送ったときの発言（`inputId`）を割り込みに変える event を出す（例: `{ kind: "steered", inputId, steerId }`）。`steer_delivered` の印は今どおり `steerId` で付く
     - formal message: `interrupt: true` と同じ（envelope に `Interrupt: yes`。`steerWithNotice` の経路）。自動の RESULT / ANSWER を作らないことなど、今の割り込みの message の扱いに合わせる
   - steer できなかったら（実行中でない・上限で待っている・Adapter の `steer` が false）、項目は mailbox の元の位置に残し、理由を返す
   - 外してから steer に失敗したら元の位置に戻す（順番を崩さない）。外さずに steer を試してから外す形でもよい
3. **shell**（`src/cli/shell.ts`）: 成功なら何も出さない。失敗は `toast`（warn）で短く（例: ja「{agent} は作業中でない」「{agent} は上限で待機中」「割り込めない」/ en は同じ方針）。ID が無ければ `/cancel` と同じ「取り消せる…」相当の文言（「送信待ちに無い: {id}」）
4. **画面**
   - Web UI（`src/web/client/pending-view.ts`）: 各行の「取り消し」の前に「割り込み」（ja「割り込み」/ en "Interrupt"）を置き、`/steer <id>` を送る。宛先の Agent が作業中でないときは押せなくする（state の Agent の status で判定）
   - timeline（`src/web/client/timeline.ts`）: `steered` で該当の発言に `steer: true`・`steerId` を付け、送信待ちの印（`queued`）を外す。保存した feed の再生でも同じになる
   - TUI: `/steer` を使えればよい（行のボタンは不要）
5. 文言は短く。「この〜」の言い回しは使わない

## テスト方針

- `input.test.ts`: `/steer <id>` の解釈
- Coordinator: 実行中の宛先への人間の入力の steer（mailbox から消え、Adapter の `steer` が呼ばれ、`steered` event が出る）、formal message の steer（envelope に `Interrupt: yes`）、実行中でない・上限で待っている・Adapter が false のとき項目が元の位置に残る
- shell: 失敗の toast、ID が無いとき
- timeline: `steered` で発言が割り込みになり、`steer_delivered` で届いた印が付く
- Web UI: 宛先が作業中でなければ「割り込み」を押せない
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、送信待ちの一覧の「割り込み」のスクリーンショットを撮って RESULT に path を書く（Agent を動かさずに送信待ちを作れるなら、それでよい）
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
