# HUB-RECOVERY: Hub の再起動からの復旧

設計の正は `docs/DESIGN.md` §18「Hub の再起動からの復旧（Phase 2）」と §12 配送ルール。この文書は実装の範囲と受入条件をまとめる。

## 背景

今は Hub を止めると、配送待ちの人間の入力と formal message は捨てられ（`AgentMailbox.close`）、作業中だったターンも失われる。起動し直すと新しい会話になる。GUI の入れ直しや `/exit` のたびに、途中の作業が消える。

## 変更

1. 保存（新規 `src/project/recovery-store.ts` など。名前は任せる）
   - パス: `conversationStatePath` の `.json` を `.recovery.json` にしたもの
   - 形: `{ current: string, conversations: Record<会話 id, { interrupted: AgentId[], queue: Record<AgentId, RecoveryItem[]> }> }`。`RecoveryItem` は `{ kind: "input"; text; images? }` か `{ kind: "message"; message: AgentMessage }`
   - zod で検証する。壊れている・読めないときは空として扱う
   - 書き込みは `writeFileAtomic`
2. 状態を取り出す
   - `AgentMailbox` に、配送待ちのうち人間の入力（`text` は suffix を付ける前の本文、`images`）と formal message を順に返す getter を足す
   - `Coordinator` に、会話の復旧用の状態（`interrupted`: status が busy の Agent、`queue`）を返すメソッドと、それが変わったことを知らせる仕組みを足す（enqueue・配送の開始・ターンの終了・cancel・discard）
   - `stop()` では、閉じる前の状態を変えない（閉じたことで空の状態を通知しない）
3. 保存のタイミング（`ProjectContext`）
   - runtime ごとの変化と、今の会話の切り替えのたびに、その project の全 runtime の状態と今の会話の id をまとめて書く。戻すものが無い会話は書かない
   - Ctrl+D（配送が終わるのを待つ）なら最後は空になる。`/exit`・GUI の終了・異常終了では直前の状態が残る
4. 起動時の復旧
   - `Hub` の起動時に、`hub.json` の project のうち `.recovery.json` に戻すものがある project を開く（今の `initial` の project も含めて重複しない）
   - `ConversationHistory` に、起動時の今の会話を id で選べるようにする（`resumeLatest` と並べるか置き換えるかは任せる）。戻す作業があるとき、または `args.serve` のときは `current` に戻す。履歴に無ければ新しい会話
   - 戻す作業がある会話は runtime を作り、次の順に積む
     1. `interrupted` の Agent に `[Clodex] Clodex restarted and your previous turn was interrupted. Continue the task you were working on.`（定数）。session が無い Agent には積まない。人間の入力と同じ経路（言語の 1 行も付く）でよいが、feed に `human` event は出さない
     2. `queue` を元の順に。人間の入力は新しい ID で積む（`human` event は出さない）。formal message は Budget を通さず同じ message のまま配送する。この message を処理中に送られた message は、新しい chain の子として数える（BudgetManager が知らない親を、新しい chain の根として扱えるようにする）
   - 戻した会話に `notice` を出す（i18n。例: `前回の終了から復旧: 中断 {interrupted} 件、配送待ち {queued} 件`）
   - 履歴に無い会話の分は捨てる
5. `index.ts` の Ctrl+D・`/exit`・シグナルの終了処理は今のまま。保存は上の変化の通知で行う

## テスト

- recovery-store: 読み書き、壊れたファイル、戻すものが無い会話を書かない
- mailbox / Coordinator: 復旧用の状態（配送待ちの入力・message、busy の Agent）、変化の通知、`stop()` で状態が空にならない
- 起動時の復旧: fake の Adapter で、続きを頼む 1 行が先に、`queue` が元の順に積まれること、session の無い Agent には続きを頼まないこと、`human` event を出さないこと、notice が出ること、formal message の後の message が Budget で拒否されないこと
- 今の会話の選び方: 戻す作業あり・serve・どちらでもない
- 実 CLI の E2E は足さない（利用枠を使うため）

## 受入（codex が確かめて RESULT に書く）

- `pnpm test`、`pnpm typecheck` が通る
- 一時的な HOME で `clodex serve` を fake ではなく実際に動かすのは Agent を起動して利用枠を使うので行わない。代わりに、Hub の起動から復旧までを fake の Adapter でつないだテストを 1 つ置く
- 実ユーザーの `~/.clodex` には触れない

コミットはしない。
