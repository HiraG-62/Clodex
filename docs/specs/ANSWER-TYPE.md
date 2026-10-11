# ANSWER-TYPE: QUESTION への返信を ANSWER にし、作業中の相手にすぐ届ける

今は QUESTION への返信も RESULT で、作業の終わりの報告と区別がつかない。また、質問した Agent が作業を続けていると、回答はそのターンが終わるまで届かない。QUESTION への返信を新しい type の `ANSWER` にし、相手が作業中なら実行中のターンに足す。RESULT は依頼（DELEGATE / REVIEW_REQUEST）の作業を終えたときだけに使う。仕様の正は `docs/DESIGN.md` §11 Message Types・Message Schema・`interrupt`、§12 配送ルール（自動の RESULT）、§13 Context Resolver・Spec・Roles の定型文、§17 ログ、§28 通知の形式。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、TUI の表示、`read_conversation`、テストの fixture など）は確認せずに触ってよい。

1. **schema**（`src/protocol/messages.ts`、MCP の `send_message` の説明）
   - type に `ANSWER` を足す。`replyTo` は必須。`spec` を許す。`status`・`issues` は不可（RESULT / ISSUE のみのまま）
   - 受け付けの検証（Coordinator）: `ANSWER` の `replyTo` が、送信元が受けた `QUESTION` の ID でなければ拒否する。`RESULT` の `replyTo` が `QUESTION` なら拒否し、エラーに「QUESTION には type="ANSWER" で返す」と書く
   - tool の説明文の type の説明に、ANSWER = QUESTION への回答、RESULT = 依頼の作業を終えたときの報告、を書く
2. **配送**（`src/coordinator/coordinator.ts`・`agent-mailbox.ts`）
   - `ANSWER` は `interrupt` の指定によらず、宛先が作業中なら（何のターンでも）実行中のターンに足す。今の `interrupt` の steer の仕組みを使う。作業中でなければ通常どおり配送する
   - 失敗したときの再送はしない（RESULT と同じ）
   - Budget は RESULT と同じ数え方
3. **自動の返信**（§12 配送ルール）: QUESTION を配送したターンで送信元へ何も送らずに終えたら、最終応答を `ANSWER`（`auto: true`、`status` なし）として返す。DELEGATE / REVIEW_REQUEST は今どおり `RESULT`。ANSWER を送っていれば自動では作らない
4. **envelope と役割の定型文**（`src/coordinator/` の envelope、`src/context/role-instructions.ts`）
   - QUESTION の返信方法を `type="ANSWER"` にする。DELEGATE / REVIEW_REQUEST の返信方法は `type="RESULT"` で、作業を終えたときに送る、と添える
   - ANSWER には返信を求めない。ANSWER に `spec` があれば「回答に合わせて更新した設計書を読み、続きの作業で従う」の 1 行（今 RESULT に付けているもの）
   - 役割の定型文: 「QUESTION には ANSWER で答える。設計書を直したら ANSWER の `spec` で渡す。RESULT は依頼の作業を終えたときに使う」
5. **画面**（`src/web/client/timeline.ts`・`log-item.ts`、TUI）
   - message のカードに `ANSWER` を出す（種類のラベルは type のまま）
   - 「質問 → 回答 → 続き」の並び（今 RESULT・自動の RESULT で確かめているもの）を ANSWER でも同じにする。steer で足した ANSWER の出し方は、今の割り込みの message と同じ
6. **通知**（NO-NOTIFY-HANDOFF の判定）: ANSWER を受けて作業を続け、message を送らずに終えたターンは途中ではない（通知する）。ANSWER を送ったターン・QUESTION を処理したターンは今どおり途中
7. Clodex が Agent に出す定型文のうち「QUESTION に答えるために設計書を直したら RESULT の spec で」などの文言を、すべて ANSWER に直す（`grep -rn "RESULT" src/` で漏れを確かめる）

## テスト方針

- schema / Coordinator: ANSWER の受け付け、`replyTo` が QUESTION でない ANSWER の拒否、QUESTION への RESULT の拒否（エラーの文言）
- 配送: 宛先が作業中なら ANSWER は steer で実行中のターンに足す（`interrupt` を付けなくても）。作業中でなければ通常の配送
- 自動の返信: QUESTION のターンは ANSWER、DELEGATE のターンは RESULT
- envelope: QUESTION の返信方法が ANSWER、DELEGATE は RESULT、ANSWER の `spec` の 1 行
- timeline: 質問 → ANSWER → 続きの並び
- 通知: ANSWER を受けて終えるターンは途中でない
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
