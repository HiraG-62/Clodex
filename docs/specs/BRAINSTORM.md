# BRAINSTORM: Claude と Codex でブレストする会話

開発の流れとは別に、Claude と Codex の 2 つの見方でアイデアを出し合う機能を作る。進め方は「広げる（互いを見ずに案を出す）→ 重ねる（相手の案を読んで発展・批評）→ まとめる」で、人は途中で止めずに最後まで自動で進める。仕様の正は `docs/DESIGN.md` §28 F「ブレスト」と、コマンドの一覧の `/brainstorm`。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、help、入力の候補、TUI、Web UI の会話の一覧・タブ、復旧、テストの fixture など）は確認せずに触ってよい。構造の判断に迷ったら QUESTION で聞く。

1. **入力**（`src/cli/input.ts`・`commands.ts`）: `/brainstorm [周回数] <テーマ>`。周回数は 1〜5（既定 2）。テーマが空なら使い方を出す
2. **会話**（`src/project/conversation-history.ts`、`src/hub/workspace.ts`・`project-context.ts`）
   - 会話に `mode?: "brainstorm"` と、ブレストの設定（テーマ・周回数）を足す。`/brainstorm` で新しい会話を作って今の会話にする（`/new` と同じ切り替え）。名前はテーマ（長ければ切る）
   - ブレストの会話の runtime: 両 Agent の権限を `read-only` にする（保存した Agent の設定より優先。人が `/permission` で変えても、ブレストの会話では read-only のまま）。役割の定型文の代わりに、ブレスト用の定型文を渡す（`src/context/role-instructions.ts` に足す。英語。相手の Agent もブレストに加わっていること、案は具体的に箇条書きで、`send_message` と `ask_user` は使わない、コードや資料は読んでよいが編集しない。言語の指示は今どおり）
   - `send_message` は拒否する（今の solo の拒否と同じ形。エラー文は英語で "brainstorm mode: do not use send_message"）
3. **進行**（新しいモジュール。例: `src/coordinator/brainstorm.ts`。Coordinator の mailbox を使って送る）
   - 1 周目: 両 Agent に同時に、テーマと「互いの案を見ずに、案を出す」の指示を送り、両方のターンが終わるのを待つ
   - 2 周目以降: 各 Agent に、相手の前の周の最終応答（長ければ 8,000 文字で切る）と「発展・組み合わせ・批評と、新しい案を出す」の指示を送る。両 Agent に同時に送って、両方を待つ
   - まとめ: primary の Agent に、両 Agent の全周の最終応答（長ければ同じく切る）と、まとめの指示（論点・案の一覧とどちらの案か・有望な案と理由・未解決の問い）を送る。まとめの最終応答を `~/.clodex/artifacts/<project>/brainstorm-<日時>.md` に保存し、ログに「資料」として出る形（`[名前](<フルパス>)` を含む notice ではなく、まとめの turn の後に Coordinator が保存し、path を最終応答に足すか、別の手段で資料の一覧に載るようにする。決めにくければ QUESTION）
   - 指示の文は英語で、末尾に言語の 1 行（今の人の入力と同じ）
   - どちらかのターンが失敗・中断で終わったら、そこで止める（`/interrupt` で止めたときも残りを送らない）。止まったことを toast で知らせる
   - 送る指示は、ログでは人の入力ではなく「ブレスト」の進行として見分けられるようにする（例: `human` event ではなく、周の見出しの event を出し、Agent の発言の枠の上に「ブレスト 1/2」「まとめ」の見出しを出す。指示の本文はログに出さない）
   - 進行中の状態（今の周）を state に出す。Hub の再起動で止まったら、復旧では続きを送らない（中断した旨を toast）
4. **画面**
   - Web UI: 会話の一覧の「新しい会話」の横に「ブレスト」のボタン（アイコン）。押すとテーマ（複数行）と周回数（1〜5、既定 2）を入れるシートを開き、`/brainstorm <n> <テーマ>` を送る。会話の一覧・タブにブレストの印
   - ログ: 周の見出し（ja「ブレスト {n}/{total}」「まとめ」/ en "Brainstorm {n}/{total}" "Summary"）
   - TUI: `/brainstorm` が使え、周の見出しが出る
5. 文言は短く。「この〜」の言い回しは使わない

## テスト方針

- `input.test.ts`: `/brainstorm` の解釈（周回数あり・なし・範囲外・テーマなし）
- 進行（fake の Adapter）: 1 周目に両 Agent へ同時に送る。2 周目に相手の前の周の応答が入る。まとめは primary にだけ、全周の応答が入る。まとめの保存。失敗・中断で止まる。進行中の人の入力は配送されず、次の周（かまとめ）の指示に両 Agent 分入る（DESIGN.md §28 F）。まとめの後の入力は通常の配送
- 会話: ブレストの会話は read-only で起動し、ブレストの定型文が入り、`send_message` が拒否される。保存と復旧で `mode` が残る
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、ブレストのシート・周の見出しの出たログ（feed の流し込み）のスクリーンショットを撮って RESULT に path を書く。実 Agent は動かさない
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
