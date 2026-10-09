# SERVER-ROBUST-3: サーバー側の小さな堅牢性の改善 4 件

独立した 4 件。コミットは件ごとに分けるので、RESULT では件ごとに変更したファイルを書く。仕様は docs/DESIGN.md（今回追記済み）の次の行。

- §28 D2b の「hub.lock の Hub が生きているかは…」
- §9 Adapter の「Codex の応答のうち…」「CLI の実行ファイルが見つからないとき…」

## A. hub.lock の生存確認を pid だけでなく HTTP でも行う

- 現状: `src/hub/hub-lock.ts` の `isHubAlive` は `process.kill(pid, 0)` だけで判定する。異常終了で lock が残り、その pid を別のプロセスが再利用していると、`src/index.ts` は存在しない Hub に接続しにいって失敗し続ける。`web-token` の `readFileSync` にも例外処理が無い
- 変更:
  - `isHubAlive` を async にし、pid の確認に加えて、lock の URL の `/manifest.webmanifest`（認証なしで返る）に短い timeout（定数。例: 1500 ms）で GET し、200 が返ったときだけ生きているとみなす
  - 生きていなければ、今どおり自分が Hub として起動する（lock は起動時に上書きされる）
  - `web-token` が読めなければ、生きていない扱いにはせず、エラーを 1 行出して終了する（token が無いと接続できないため）。文言は `src/i18n/messages.ts`
  - GUI（`gui/src-tauri`）の lock の扱いは変えない
- テスト: pid が生きていて HTTP が応答しない・200 以外・timeout のとき false、200 のとき true。HTTP の取得は注入できる形にする

## B. `AgentMailbox.hold` を二重に呼んでも timer を漏らさない

- 現状: `src/coordinator/agent-mailbox.ts` の `hold()` は、既にある `holdTimer` を消さずに上書きする。今の呼び出し元では起きないが、呼び出し順が変わると timer が漏れ、続きの指示が 2 回積まれる
- 変更: `holdTimer` があれば何もしない（先の hold を保つ）
- テスト: `hold` が 2 回呼ばれても、再開の指示は 1 回だけ積まれる

## C. Codex の応答の形を確かめる

- 現状: `src/agents/codex-adapter.ts` は `thread/start`・`thread/resume`（119 行付近）、`turn/start`（197 行付近）、`account/read`（233 行付近）の応答を `as` で型付けしているだけ。CLI の更新で形が変わると `response.thread.id` が TypeError になり、原因の分かりにくいエラーで起動に失敗する
- 変更: これらの応答を zod の schema で `safeParse` し、失敗したら `codex: unexpected response to <method>: <JSON の先頭 200 文字>` のエラーにする。schema は使うフィールドだけを要求し、それ以外のフィールドは許す（`passthrough` か通常の object）。`as` を使わない
- テスト: 想定外の形の応答で、method 名を含むエラーになる。今の形の応答では今どおり動く

## D. CLI の実行ファイルが見つからないときのエラー

- 現状: `src/agents/agent-process.ts` は shell を使わずに `claude`・`codex` を spawn する。PATH に `.exe` が無いと（npm で入れた `.cmd` だけの場合を含む）、`ENOENT` で起動に失敗し、`claude process exited (code null)` のような分かりにくい文言になる
- 変更: spawn の `error` が `ENOENT` のとき、`<command> が見つからない（PATH に <command>.exe が必要）` / `<command> not found (<command>.exe must be on PATH)` の文言で、起動の失敗として Agent の `error` に出す。文言は `src/i18n/messages.ts`。shell は使わない（`--append-system-prompt` などの引数がコマンドインジェクションの原因になるため）
- テスト: fake の spawn が `ENOENT` を出したとき、Adapter の `start` がこの文言のエラーで失敗する

## 変更してよいファイル

- `src/hub/hub-lock.ts`・`src/hub/hub-lock.test.ts`・`src/index.ts`
- `src/coordinator/agent-mailbox.ts`・`src/coordinator/agent-mailbox.test.ts`
- `src/agents/codex-adapter.ts`・`src/agents/codex-adapter.test.ts`・`src/agents/agent-process.ts`・`src/agents/agent-process.test.ts`・`src/agents/claude-adapter.ts`・`src/agents/claude-adapter.test.ts`・`src/agents/base-agent-adapter.ts`
- `src/i18n/messages.ts`

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
