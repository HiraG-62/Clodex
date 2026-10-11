# QUESTION-IN-TURN: 人への質問をそのターンの枠の中に出す

Agent が `ask_user` で質問すると、ログに質問の記録（「回答待ち」）が別の項目として並び、質問したターンの枠（方針・作業・最終応答）とは別の枠になる。formal message と同じく、質問のカードをそのターンの枠の本文に入れる。仕様の正は `docs/DESIGN.md` §17 ログの「人への質問（`ask_user`）も、formal message と同じく…」。事象のスクリーンショット: `C:/Users/Horry/.clodex/uploads/E--dev-Clodex-ce95cf0d/20261011T144510-f4af52dc.png`（「Claude 23:43 回答待ち」の項目と、23:42 のターンの枠が別々）。

## 変更

対象のファイルは目安（`src/web/client/timeline.ts`・`log-item.ts`・`log-view.ts`、TUI の `src/tui/terminal-layout.ts`）。同じ目的に要るファイルは確認せずに触ってよい。

1. **timeline**: `question` event を、その Agent の作業中のターン（無ければ直前に終わった同じ Agent のターンのうち、message と同じ判定で結び付くもの）の本文に入れる。今の `turn.messages` と同じ扱いにする（例: `turn.questions`、または message と質問を送った順に並べる 1 つの列）
   - ターンの区切り（作業中のターンで message を送ったら区切る）を、質問でも同じにする
   - 最終応答の移し方（本文に message があれば最終応答は畳んだ「作業」の最後へ）も同じにする
   - `answer` event で、ターンの中の質問のカードに回答を付ける
   - 結び付けるターンが無いとき（復旧の再生など）は、今どおり別の項目
2. **描画**: ターンの枠の中に、今の質問の記録と同じ中身（質問・選択肢・回答待ち / 回答）のカードを出す。画面下の質問欄（回答するところ）は今のまま
3. **TUI**: 同じ timeline を使っているなら合わせる
4. 「質問 → 回答 → 続き」の並び（今のテスト）が崩れないこと

## テスト方針

- `timeline.test.ts`: 作業中のターンで質問したら枠の本文に入る、回答が同じカードに付く、質問の後に作業が続けば区切る、質問して終えたターンは 1 つの枠、結び付くターンが無ければ別の項目、保存した feed の再生でも同じ
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、質問を含むターンを feed で流し込み、回答前と回答後のスクリーンショットを撮って RESULT に path を書く
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
