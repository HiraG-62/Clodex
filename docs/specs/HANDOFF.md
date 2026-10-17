# HANDOFF: `/handoff <agent>` で引き継ぎの資料を書かせてから session を新しくする

統合役の session が大きいまま続くと、tool の呼び出しのたびに大量の token を送り直す（ブレストの実測で Claude のターン終了時のコンテキスト中央値が約 310〜370k）。`/new <agent>` では決定事項が失われるので、人が区切りで `/handoff <agent>` を送ると、その Agent に引き継ぎの資料を書かせ、新しい session の最初の配送にその path を添える。仕様の正は `docs/DESIGN.md` §14「session の大きさ」の「引き継ぎ」と、§8 のコマンド表。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、`/help`、補完、テスト）は確認せずに触ってよい。

1. **入力**（`src/cli/input.ts`・`commands.ts`）: `/handoff <claude|codex>`。Agent は必須（省略・不正は usage）。補完に Agent 名
2. **受け付けの条件**（Coordinator に `handoff(agent)` のような入口を作る。`src/coordinator/coordinator.ts`）
   - その Agent が idle、mailbox に配送待ちが無い、その Agent 宛ての依頼（`DELEGATE`・`REVIEW_REQUEST`・`QUESTION`）に終わっていないものが無い、subagent・background task が動いていない
   - 満たさなければ理由を warn で出して何もしない（例: ja「{agent} は作業中」「{agent} に未完了の依頼」「{agent} の subagent が動作中」。en も同じ方針。UI 文言は短く）
   - 停止中（まだ起動していない・session が無い）なら、引き継ぐものが無いので `/new <agent>` と同じことだけをする
3. **資料を書かせるターン**
   - path は Coordinator が決める: 会話の artifacts のディレクトリ（`role-instructions` の `artifactsDir` と同じ）の `handoff-<agent>-<YYYYMMDD-HHmmss>.md`
   - 人の入力と同じ経路で 1 ターン送る（Budget は人の入力の chain）。固定の指示は英語の定数にする。内容: 「Write a handoff document to <path> for your next session: decisions made, open issues, the human's latest decisions, paths to evidence (commits, specs, screenshots), and requests you sent that are still waiting for a reply (message ID and taskId). Then reply with only the path.」
   - ログには人の入力として出してよい（`/compact` のように専用の表示にしてもよい。簡単な方）
4. **切り替え**
   - ターンが `completed` で、path が空でない通常ファイルとしてあれば、`/new <agent>` と同じ処理（`shell.ts` の `startFresh(agent)` の中身: `switchSessions({}, [agent])` と `history().clearSession(agent)`）をする。成功したら info（ja「{agent} を引き継ぎ: {path}」）
   - 失敗・中断・資料が無いときは切り替えずに warn（ja「{agent} の引き継ぎに失敗」）
5. **新しい session への最初の配送に添える**
   - `DeliveryNotes` の `pendingNotices`（`src/coordinator/delivery-notes.ts`）に `[Clodex] Handoff: your previous session wrote <path>. Read it before continuing.` を積む。次の配送（人の入力でも message でも）に添わる。ターンは起こさない
   - Hub の再起動では持ち越さない（復旧の保存に足さない）
6. **toast**: `notice.threadTokenWarn` の文言の `/new {agent}` を `/handoff {agent}` にする（ja・en）
7. Web UI: 新しいボタンは作らない（コマンドだけ）。入力の補完に出れば十分

## テスト方針

- `input.test.ts`: `/handoff codex` の解釈、Agent の省略・不正は usage
- Coordinator（fake adapter）:
  - 条件を満たさないとき（busy・配送待ちあり・宛ての未完了の依頼あり・subagent あり）は何も送らず warn
  - 送った依頼の返事待ちがあっても受け付ける
  - 資料を書いたターンの後に session が変わり、次の配送の先頭（delivery note）に path が添わる。その次の配送には添わらない
  - ターンが失敗・資料が無いときは session が変わらない
  - 停止中の Agent は `/new` と同じになる
- toast の文言
- 最後に `pnpm test`・`pnpm typecheck`・`pnpm lint` を 1 回ずつ。コミットはしない

## 触ってよいファイル

- `src/cli/**`、`src/coordinator/**`、`src/hub/**`、`src/index.ts`、`src/i18n/messages.ts` とそれぞれのテスト
- 生成コマンドが書き換えるファイル
- `docs/DESIGN.md` は触らない（矛盾を見つけたら QUESTION）
