# CONVERSATION-TABS: プロジェクトをまたぐ会話のタブ

プロジェクトをまたいで、特定の会話へすぐ移れるタブを出す。ピン止めは会話の一覧のピン止めと同じもの、タブの並びは Hub が持つ（PC とスマホで同じ）。仕様の正は `docs/DESIGN.md` §28 D2a の「タブ」。

## 変更

1. **タブの一覧を作る**（Hub。`src/hub/` に純粋な関数を置く。例: `src/hub/tabs.ts`）
   - 入力: プロジェクトの一覧（`hub.list()` の順）、プロジェクトごとの会話の一覧（開いているプロジェクトは `context.history.list()`、開いていないプロジェクトは保存してある一覧を `loadConversations(conversationStatePath(homeDir, projectRoot))` などで読む）、今のプロジェクトと今の会話、開いているプロジェクトの会話ごとの activity
   - 出力: `Array<{ projectRoot; conversationId; title; pinned; current; activity? }>`。ピン止めした会話（プロジェクトの一覧の順、その中は会話の一覧の順）＋ 今の会話がピン止めしていなければ末尾に 1 つ
   - 開いていないプロジェクトの一覧の読み込みは state のたびに読み直すと重いので、ファイルの更新時刻で読み直すか、Hub がピン止めを変えたときだけ読み直す
   - state（`src/web/web-feed.ts` の `WebState`、`src/index.ts`）に `tabs` を入れる
2. **`/tab` コマンド**（`src/cli/input.ts`・`src/cli/shell.ts`・`src/cli/commands.ts`・`src/index.ts`）
   - `/tab <会話 ID> <project root>`: そのプロジェクトを今のプロジェクトにして（開いていなければ開く。今の `/project <path>` と同じ処理）、その会話に切り替える（`/resume` と同じ処理を ID で）。会話が無ければ通知して何もしない
   - `/tab unpin <会話 ID> <project root>`: その会話のピン止めを外す。プロジェクトが開いていれば `history.togglePin`（外す方向だけ）、開いていなければ保存してある一覧を書き換える（`ConversationHistory` を一時的に作って外すなど。今の会話の扱いで余計な会話を保存しないこと）
   - 結果は今の `/pin`・`/resume` と同じく notify。ログには入れない
   - help と引数の候補は無くてよい（画面から送る用）。`commands.ts` には載せる
3. **Web UI**（`src/web/client/client-main.ts`、`src/web/web-page.ts`）
   - タブの帯: PC は右の列の上端（ヘッダの下）、スマホはヘッダの下。横に並べ、収まらなければ横にスクロール。今の会話のタブは選ばれた見た目（今の会話の一覧の選択の見た目に揃える）
   - タブ: プロジェクト名（フォルダ名。小さく）・会話名（長ければ省略）・作業中の印（`activity === "busy"` のとき、会話の一覧と同じ印）
   - ピン止めしたタブに ×（`/tab unpin …`）、ピン止めしていない今の会話のタブに pin のアイコン（今の会話の番号で `/pin <番号>`）。まだ保存されていない新しい会話（`history.list()` に無い）には出さない（無効にせず隠す）。`/tab pin` は足さない。どちらも `aria-label` と title
   - タブを押すと `/tab <ID> <project root>`（今の会話のタブは何もしない）。切り替えの間はトップのバーを出す（今の会話・プロジェクトの切り替えと同じ）
   - 文言は足さない（アイコンと名前だけ。ラベルの文言が要るなら `aria-label` の「ピン止め」「ピン止めを外す」は既存のキーを使う）
4. TUI は今のまま

## テスト方針

- `tabs.test.ts`: ピン止めだけが並ぶ・順序（プロジェクトの一覧の順、その中の順）・今の会話がピン止めしていなければ末尾・ピン止めしていれば重ねない・開いていないプロジェクトには activity を付けない
- `input.test.ts`: `/tab <id> <path with spaces>`、`/tab unpin <id> <path>`、引数の欠け → 使い方
- `shell.test.ts`: `/tab` で project を開いて会話を切り替える（fake の projects）、`/tab unpin` で外れる、無い会話は通知
- 開いていないプロジェクトの保存してある一覧のピン止めを外せる（`conversation-history.test.ts` か `tabs` 側）
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で確かめる。空のホームで、一時フォルダに git のリポジトリを 2 つ作って `/project` で開き、会話を作ってピン止めし、タブで行き来できることを PC とスマホで確かめる（Agent には送らない）。スクリーンショットの path を RESULT に書く
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
