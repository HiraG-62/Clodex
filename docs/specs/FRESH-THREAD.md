# FRESH-THREAD: 依頼を新しい session で届ける口と、Codex の待ち方の作法

roguelike プロジェクトで Claude が設計・Codex が実装する運用をしたところ、Codex の 1 本の thread が 3 日リセットされず（DELEGATE 155 回・tool 6,924 回・compact 38 回）、コンテキストが 15〜24 万 token に張り付いて、使用量の約 76% を占めた。tool を呼ぶたびにコンテキスト全体を送り直すため。送る側が「新しいタスク」と判断したら、宛先の session を新しくしてから届けられるようにする。あわせて、Codex に待ち方の作法を伝える。

仕様の正は `docs/DESIGN.md`: §11 の `fresh`、§12「新しい session で届ける」、§13 Roles の設定のキー（`freshThread`）と Codex の作法。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、設定の読み込み、復旧の保存、TUI、テストの fixture など）は確認せずに触ってよい。

1. **schema**（`src/protocol/messages.ts`）: `fresh?: boolean` を足す。`DELEGATE` / `REVIEW_REQUEST` 以外で `true` なら拒否。`interrupt` と両方 `true` なら拒否。tool の説明: "Start the recipient in a new session before delivering (DELEGATE / REVIEW_REQUEST only). Use for a new task that does not need the recipient's earlier context."
2. **設定**（`src/project/` の設定の読み込み）: `freshThread`（キーは `DELEGATE` / `REVIEW_REQUEST`、値は boolean）を読む。project の `.clodex.json` がユーザーの設定を上書き（今のトップレベルのキー単位の規則）
3. **Coordinator**（`src/coordinator/coordinator.ts`・`agent-mailbox.ts`）
   - 受け付けたとき、message に `fresh` が無ければ設定の既定を当てはめて message の `fresh` に入れる（`false` なら付けない）
   - mailbox がその message を配送する番になったら、宛先の session がすでにあれば `/new <agent>` と同じこと（今の session を会話から外して保存し、プロセスを止める）をしてから、新しい session で起動して envelope を送る。今の `/new <agent>` の処理（history の `clearSession`・Coordinator の session の切り替え）を再利用する
   - 配送待ちの間に Hub が止まっても、復旧で同じく新しい session で届ける（recovery の queue に message ごと残るなら追加の対応は不要のはず。確かめる）
   - `fresh` の message は `interrupt` の steer の対象にしない（schema で拒否しているが、設定の既定で `fresh` になった message に `interrupt: true` が付いていたら、steer せず通常どおり配送する）
4. **画面**: message のカードに「新しい session」の印（ja「新しい session」/ en "New session"。`auto`・割り込みの印と同じ置き方）。TUI も同じ
5. **役割の定型文**（`src/context/role-instructions.ts`、両 Agent・英語）: 「新しいタスクを頼むときは `fresh: true` を使ってよい。fresh の依頼は前の作業の記憶が無い相手に届くので、envelope と spec だけで作業できるように書く」
6. **使用量を減らす作法**（`role-instructions.ts`・設定の読み込み。英語）: 役割の分け方は人によって違うので、Agent ごとに設定の `usageHints`（`{ "claude": boolean, "codex": boolean }`、既定は両方 `false`）で ON にしたときだけ足す（DESIGN.md §13 Roles「使用量を減らす作法」）
   - 共通: Do not poll in small steps (repeated `sleep`, or checking subagents again and again). Read the relevant range of a file at once, not a few dozen lines at a time.
   - Codex: Run long commands (tests, builds) with a long enough `yield_time_ms` to finish in one call. Do not poll with `wait` or `write_stdin`.
   - Claude: Run long commands with a long enough Bash `timeout` (up to 600000 ms) to finish in one call. Do not check `run_in_background` commands again and again with `sleep` or by re-reading their output.
7. 文言は短く

## テスト方針

- schema: `fresh` の受け付けと拒否（type・`interrupt` との組み合わせ）
- 設定: `freshThread` の読み込みと project の上書き
- Coordinator: `fresh` の DELEGATE を配送するとき、宛先の前の session が会話から外れ、新しい session で起動して envelope が届く（fake の Adapter で、`resumeSessionId` が無い起動になる）。宛先が作業中なら今のターンの後。session がまだ無ければ何もしない。設定の既定が当てはまる・message の `fresh: false` が設定より優先する
- 役割の定型文: fresh の 1 文が両 Agent に入る。作法は `usageHints` で ON にした Agent にだけ、その Agent 用の文が入る（既定では入らない）
- timeline / TUI: 印が出る
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
