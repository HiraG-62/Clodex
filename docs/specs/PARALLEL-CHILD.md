# PARALLEL-CHILD: 作業中の Agent への独立した依頼を、子の会話で並列に受けさせる

作業中の Agent に別の依頼を渡したいとき、今はロール文で「メインは待機し、作業はサブエージェントで」と書くしかない。親が `wait_agent` で待ち続け（ある thread で 105 回・約 1,400 万 token）、親と子で同じコンテキストを二重に読んでいた。`send_message` の `parallel` で、Clodex が同じ Agent を子の会話で動かし、並列に受けさせる。仕様の正は `docs/DESIGN.md` §11 の `parallel`・`worktree`、§28 D1「子の会話で並列に受ける」。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、復旧、TUI、テストの fixture など）は確認せずに触ってよい。大きな変更なので、構造の判断に迷ったら QUESTION で聞く。

1. **schema**（`src/protocol/messages.ts`）: `parallel?: boolean`・`worktree?: boolean` を足す。`parallel` は `DELEGATE` / `REVIEW_REQUEST` のみ、`interrupt`・`fresh` との併用は拒否、`worktree` は `parallel` のときだけ。Coordinator が付ける `thread?: string`（子の会話 ID）も message に足す（Agent の入力では受け付けない）。tool の説明: "When the recipient is busy, run this request in a separate conversation of the same agent so it works in parallel. The recipient starts without its earlier context."
2. **会話の履歴**（`src/project/conversation-history.ts`）: 会話に `parent?: { conversationId; messageId; from; to }` を足す。子の会話を今の会話にせずに作る口（今の `startNew` は今の会話を切り替えるので、切り替えない版）
3. **Coordinator → Workspace**（`src/coordinator/coordinator.ts`、`src/hub/workspace.ts`・`project-context.ts`）
   - `receiveMessage` で `parallel` の message を受け付け、宛先が作業中（`busy` か mailbox が空でない）なら、Workspace に子の会話を頼む（Coordinator の options に `startParallel(message)` のような口）。作業中でなければ通常どおり配送する
   - Workspace: 子の会話を作り（`worktree` なら `createWorktree`）、runtime を作って、宛先の Agent に envelope（`Parallel: yes (a separate conversation; your other work continues elsewhere)` の 1 行を足す）を配送する。今の会話は切り替えない
   - **子 → 親の転送**: 子の runtime の Coordinator で、宛先の Agent が相手の Agent に送る formal message（自動の `RESULT` / `ANSWER` を含む）は、子の相手の mailbox に積まず、親の runtime の Coordinator に渡す。親では message に `thread`（子の会話 ID）を付けて bus に出し、親の送信元へ配送する。Budget は親の chain で数える（親の依頼の message を親とする）
   - **親 → 子の返信**: 親の Coordinator で、`replyTo` が `thread` 付きの message を指す返信（`ANSWER` など）は、子の runtime の宛先へ配送する
   - 子の会話の相手の Agent は起動しない
   - 復旧: 子の会話も普通の会話として保存・復旧される。親子の結び付き（`parent`・`thread`）は保存したものから戻す
4. **画面**
   - message のカードに「並列: {子の会話名}」の印（押すと `/resume` 相当で子の会話へ切り替える）。ja「並列」/ en "Parallel"
   - 子の会話は会話の一覧に出さない（親の message のカードの印から開く。開いている間はタブに出してよい。印と親の会話名を添える）
   - TUI: message の行と会話の一覧に同じ印
5. **片付け**（DESIGN.md §28 D1「子の会話で並列に受ける」の片付け）
   - 会話の履歴: 子の会話（`parent` のあるもの）は保存の上限（`MAX_CONVERSATIONS`）に数えない。一覧（state の `conversations`・`/resume` の一覧・番号）から外す。親を消したら（`/delete`）子も消す
   - 子の会話の宛先が、親の依頼への `RESULT`（自動の `RESULT` を含む。`replyTo` が親の依頼の message ID）を送り、そのターンが終わって子の会話の mailbox が空になったら、子の会話の Agent を止める（runtime は残し、後で親の返信や人の入力が来たら今どおり resume で起動する）
6. **役割の定型文**（両 Agent・英語）: 「相手が作業中で、今の作業と独立した依頼なら `parallel: true` を使ってよい。同じファイルに触れるなら `worktree: true` を付けるか、終わるのを待つ」
7. 文言は短く

## テスト方針

- schema: `parallel`・`worktree` の受け付けと拒否
- Coordinator / Workspace（fake の Adapter）: 宛先が作業中なら子の会話ができ、子の宛先が新しい session で起動して envelope（`Parallel: yes`）を受け取る。今の会話は変わらない。宛先が作業中でなければ通常の配送。`worktree` で worktree が作られる
- 子の宛先の `send_message`（RESULT・QUESTION）と自動の RESULT が親の送信元へ `thread` 付きで届く。親の ANSWER が子の宛先へ届く。子の相手の Agent は起動しない
- Budget が親の chain で数えられる
- timeline: `thread` 付きの message に印
- 片付け: 子の会話が一覧と上限に数えられない、親の削除で子も消える、親の依頼への RESULT（自動を含む）のターンが終わったら子の Agent が止まり、その後の親の返信で resume して起動する
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、子の会話と `thread` 付きの message を feed と state に差し込み、印と切り替えのスクリーンショットを撮って RESULT に path を書く
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
