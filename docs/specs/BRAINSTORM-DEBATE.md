# BRAINSTORM-DEBATE: ブレストを順番に議論する形にし、結論を開発へ引き継ぐ

今のブレストは「全員が同時に案を出す → 次の周で他の人の前回の発言を読んで発展させる」を固定の周回数だけ繰り返す。指摘された側が反論・修正する往復が無く、意見が割れたまま終わる。これを「開幕（同時）→ 順番に発言する議論（反論役を周ごとに交代）→ 立場の集計で合意を判定 → まとめ」に作り直し、まとめの後に結論を普通の会話へ引き継いで開発に進めるようにする。

仕様の正は `docs/DESIGN.md` §28 F（更新済み。通知・人も参加するモード・開発への引き継ぎを含む）。人の決定: 進め方は順番に発言、終わり方は合意（上限あり）、参加者は常に全 Agent（任意で人も参加）、反論役を周ごとに回す、ブレスト中の通知は最終完了と問題のときだけ。

## Fixed

### 進行（`src/coordinator/brainstorm.ts`・`coordinator.ts` の `startBrainstorm`）

- 周回数（`BrainstormConfig.rounds`）の意味を「議論の周の上限」に変える。既定 3、範囲 1〜5（`/brainstorm` の解釈・Web のフォームの既定値と範囲も合わせる）
- **開幕**: 全 Agent に同時にテーマを送る（今の 1 周目と同じ。互いの案を見せない）。案 ID の指示は今どおり `AGENT_META.ideaPrefix`
- **議論**: 周 n（1 始まり）で全員が 1 回ずつ、**1 体ずつ順に**発言する（前の発言者のターンが終わってから次へ送る）
  - 発言順: `AGENT_IDS` を周ごとに先頭を 1 つずらす（周 n の先頭は `AGENT_IDS[(n - 1) % N]`）
  - 反論役: 周 n は `AGENT_IDS[(n - 1) % N]`（= その周の先頭の発言者）
  - 発言者に渡すもの: 自分の前回の発言（開幕を含む）の後に出た、他の全員の発言（発言者名付き・時系列。1 発言は今の `BRAINSTORM_RESPONSE_LIMIT` で切る）
  - 指示（英語）: 名指しの質問と自分の案への批評に答える（反論・修正・取り下げを明示）、他の案を ID で批評する、組み合わせ・新しい案を出す（ID は通し番号を続ける）、必要なら相手を名指しで質問する。反論役には「有望とされている案ほど強い反論・見落とし・失敗する条件を挙げる。役とは別に、本心の立場をブロックに書く」を足す
  - 立場のブロック: 発言の最後に必ず次の形で書かせる（開幕では書かせなくてよい）
    ````
    ```stance
    C1: support
    X2: conditional
    G1: oppose
    open: none
    ```
    ````
    `support | conditional | oppose` の 3 値。最後の行は `open: none` か、続けたい論点 1 行
- **立場の集計**: Coordinator が各発言から `stance` ブロックを読み、Agent ごとの最新の立場（案 ID → 値）と `open` を持つ。読み取れない発言は「その Agent の立場は不明」にする（前の値で埋めない）。解析は寛容に（前後の空白・大文字小文字・余分な行は無視。不正な行は捨てる）
- **合意の判定**: 周の終わりごとに判定する。全員の最新の立場が読めていて、どの案 ID についても `support` と `oppose` が同時に存在せず、全員が `open: none` なら合意。合意か上限で議論を終え、まとめへ進む
- **まとめ**: primary に、全発言（開幕・議論。発言者と周付き）と立場の集計表、終えた理由（合意 / 上限）を渡す。指示は DESIGN §28 F の 4. のとおり（表の列: ID・提案者・各 Agent の最終の立場・現状・根拠。上限で終えたら割れた案と双方の主張を明記）。保存（artifact）は今どおり
- 人の入力: 進行中の入力は今どおり溜め、**次に送るターン**（開幕中なら議論の最初の発言者、議論中なら次の発言者、まとめの番ならまとめ）の先頭に「人が足したこと」として渡す。ターンが失敗・中断したら今どおり戻す
- `/interrupt`・Hub の再起動での中断の扱いは今どおり（残りを送らない、再起動後は stopped）
- 完了判定は「まとめのターンが completed」（今の `responses.length === rounds × N` の判定はやめる）

### イベントと画面

- `brainstorm` event に議論の進捗を足す: 周の開始で `{ phase: "round", round, total, advocate }`、議論の終わりで終えた理由 `{ phase: "summary", total, reason: "consensus" | "limit" }`。開幕は `round: 0` か専用の phase（裁量）
- 画面（Web・TUI）: 周の見出しを「周 n/上限 · 反論役 <Agent 名>」に、まとめの見出しに終えた理由（「合意」「上限」）を出す。i18n に文言を足す（UI 文言ルール: 体言止め・短く）
- 定型文（`src/context/role-instructions.ts` の brainstorm の行）: 「他の全 Agent も議論に加わる。案は具体的に、批評は ID で指す、名指しの質問には次の発言で答える、議論の発言では毎回 stance ブロックを書く。send_message と ask_user は使わない。ファイルは読んでよいが編集しない」に更新する

### 開発への引き継ぎ（`/develop [指示]`）

- 入力の解釈に `/develop [指示]` を足す（`src/cli/input.ts`・`commands.ts`・ヘルプ）
- 条件: 今の会話がブレスト（`mode: "brainstorm"`）で、まとめを終えている（artifact が保存済み = 今の `brainstormComplete` の判定）。満たさなければ拒否し、warn の通知「まとめの後に使える」
- 動作: 今の project に普通の会話（`mode` なし）を作って今の会話にし（`workspace.startNew` と同じ流れ）、primary の Agent に最初の入力を送る
  - 本文（英語の定型文）: `[Clodex] Continue from the brainstorm "<テーマ>". Read the summary at <artifact の絶対 path>, then move the adopted ideas (adopted / adopted with changes) into development following your role (design document, delegation, and so on).` 人の指示があれば `Human instruction: <指示>` を次の行に足す。資料の本文は貼らない
  - ログ上は人の入力として表示してよい（通常の入力と同じ扱い）
- 会話の履歴に引き継ぎ元を記録する: `Conversation` に `from?: { brainstorm: string }`（元の会話 ID）を足す（`src/project/conversation-history.ts` の schema。既存の保存データは影響なし）
- 画面: 引き継いだ会話のタブ・一覧に引き継ぎ元の印（アイコン。押すと元のブレストの会話に切り替える）。まとめを終えたブレストの会話の、まとめの見出しに「開発へ」ボタン。押すと任意の指示を入れる欄を出し、`/develop [指示]` を送る（空でもよい）。既存のシート・フォームの流儀に合わせる

### 通知

- ブレストの開幕・議論のターンが `completed` で終わったら、ターンの終わりの event に途中のターンの印を付ける（既存の `handoff: true` と同じ扱いで Hub が通知を作らない）。まとめのターンには付けない（ブレストの完了として通常どおり通知する）
- 失敗・中断・Agent のエラー・利用枠の上限での停止は今どおり通知する（印を付けない）
- 人も参加するモードで人の番になったら、`notify` を出す（新しい種類 `yourTurn`。本文「あなたの番です。」/ "Your turn."、Agent 名は付けない）。Web Push の対象にも入れる（人への質問と同じ扱い）。`src/hub/notify-format.ts`・`workspace.ts` の通知の作り方に合わせる

### 人も参加するモード（`--join`）

- `/brainstorm [周回数] [--join] <テーマ>` を解釈する。Web のブレストのフォームに「参加」のトグル（既存の `.settings-switch` の見た目）を足し、ON なら `--join` を付けて送る
- 会話の履歴の `brainstorm` に `join: true` を記録する（`BrainstormConfig.join?: boolean`。schema を足す）
- 人の番: 開幕の後と、議論の各周の最後。人の番の間は進行を止めて待つ（時間切れ無し）。状態に「人の番」（例: `brainstormState.phase = "human"`）を出し、画面が分かるようにする。復旧の phase の enum にも足す（再起動後は今どおり stopped）
- 人の番の操作:
  - 普通の入力（宛先によらず配送しない）→ 人の発言として記録し、次へ進む。ログ上は人の入力として表示し、「次の周へ」の印は付けない（人の発言そのもの）
  - `/pass` → 発言せずに進める。`/conclude` → 議論を終えてまとめへ（終えた理由は `"human"` を足す）。人の番でないとき・ブレストでない会話では拒否し、warn の通知（「人の番ではない」）
  - Web: 人の番の間、入力欄の上に「あなたの番」と「パス」「まとめへ」のボタン（それぞれ `/pass`・`/conclude` を送る）
- 人の発言は以降の Agent の発言者に `Human` の発言として渡す。定型文に「人の発言に案があれば、最初に取り上げた Agent が H1, H2…の ID を付ける。人の発言にも答える」を足す（join のときだけ）
- 合意の判定: Agent の立場だけで判定する。その周に人が発言したら、その周では合意にしない。上限の周で人が発言したら、Agent が応える周を 1 回だけ足してからまとめへ
  - 足した周の最後には人の番を設けず、そのまままとめへ進む（終わりを有限に保つため）。足した周の間の人の入力は、人の番以外の入力と同じく溜めて次の発言者（最後の発言者の後ならまとめ）に渡す
- 人の番以外の入力は今どおり溜めて次の発言者に渡す

### テスト

- brainstorm.ts: 発言順と反論役の回り方、発言者に渡す範囲（自分の前回以降の他者の発言だけ）、stance の解析（正常・壊れた行・ブロック無し）、合意の判定（混在あり / なし / open あり / 不明あり）
- coordinator: 開幕は同時・議論は順番、合意で上限前に終わる、上限で終わる、人の入力が次の発言者に入る、中断で残りを送らない、まとめの完了判定
- `/develop`: 条件を満たさないと拒否、満たすと新しい普通の会話を作り primary に定型文（path・テーマ・人の指示）を送る、`from` が記録される
- Web: 周の見出しの表示、「開発へ」ボタンの表示条件と送るコマンド、引き継ぎ元の印
- 通知: ブレストの途中の completed ターンは通知しない、まとめ・失敗・エラーは通知する、人の番で `yourTurn` を出す
- 参加モード: 人の番で止まる、入力が人の発言になり以降の発言者に渡る、`/pass`・`/conclude`、人の番でない `/pass` の拒否、人が発言した周は合意にしない、上限の周で人が発言したら 1 周足す
- 実 CLI の E2E は書かない

### 編集してよいファイル

- `src/coordinator/brainstorm.ts`・`coordinator.ts`・`event-bus.ts` と各テスト
- `src/context/role-instructions.ts` と同テスト
- `src/cli/input.ts`・`commands.ts`・`shell.ts`・`src/index.ts` と各テスト（`/develop`）
- `src/hub/workspace.ts`・`project-context.ts`・`tabs.ts` と各テスト
- `src/project/conversation-history.ts`・`recovery-store.ts` と各テスト
- `src/web/client/`（log-view・sheets・state-view・timeline・store・viewport ほか必要な範囲）・`src/web/web-feed.ts`・`feed-store.ts`・`src/tui/terminal-layout.ts` と各テスト
- `src/logging/event-log.ts`、`src/i18n/messages.ts`
- `src/hub/notify-format.ts`・`src/web/push.ts`（通知の種類 `yourTurn`）と各テスト

`docs/DESIGN.md`・`docs/specs/` は編集しない（矛盾や設計の変更が要るときは QUESTION）。

## Discretion

- 開幕の event の表し方（`round: 0` か専用の phase）
- stance の解析の細部（寛容さの範囲）、集計表の文字列の形（まとめへの渡し方）
- 議論の指示文の言い回し（趣旨を変えない範囲）
- `/develop` の新しい会話のタイトル（例: テーマを流用）
- 「開発へ」の入力欄の UI（既存のブレストのフォームの流儀で）
- 引き継ぎ元の印のアイコン
