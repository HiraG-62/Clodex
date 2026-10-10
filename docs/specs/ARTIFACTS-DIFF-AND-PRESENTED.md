# ARTIFACTS-DIFF-AND-PRESENTED: 成果物の差分を git の差分の形で出し、「資料」の欄を分ける

成果物の「差分」は今の `git diff HEAD` なので、コミット済みのファイルは差分が空になり、中身だけが出る（こまめにコミットする運用ではほぼ出ない）。また、作業中に触れたファイルと、Agent が人に見せるつもりで出したファイルが 1 つの一覧に混ざっている。仕様の正は `docs/DESIGN.md` §28「B — 成果物のプレビュー」。

## 変更

対象のファイルは目安。`src/index.ts`（`preview.diff` に `since` を渡す）、`src/web/client/style.css`（差分の色）、`src/i18n/messages.ts`（見出し・「全体」）など、同じ目的のために要るファイルは確認せずに触ってよい。

1. **差分の API**（`src/project/file-preview.ts`、`src/web/web-server.ts`）
   - `GET /api/diff?path=&since=<ISO 8601>` を受け付ける。`since` があれば、その時刻より前の最後のコミット（`git rev-list -1 --before=<since> HEAD`）と作業ツリーの差（`git diff <commit> -- <path>`）を返す。コミットが無ければ空の木（`4b825dc642cb6eb9a060e54bf8d69288fbee4904`）との差。未追跡のファイル（`git ls-files --error-unmatch` で判定）は全行を追加にした unified diff を作って返す
   - `since` が無ければ今どおり `git diff HEAD`
   - git の呼び出しは今の `safeGitArgs` を使う（外部 diff・hook を動かさない）。`since` は ISO 8601 として検証する
   - 対象は今どおり project root の中の通常ファイル（artifacts の中は git の外なので差分なし）
2. **一覧を 2 つの欄に分ける**（`src/web/client/artifacts.ts` の `collectArtifacts`、成果物のシートの描画）
   - `collectArtifacts` が各項目に `group: "presented" | "work"` と、そのファイルに最初に触れた時刻（`firstAt`）を付ける
   - presented（資料）: Agent の最終応答（turn の `text`）と formal message の `body` に書かれたパス（Markdown のリンク `[名前](<パス>)`・`[名前](パス)` の href、絶対パス（`C:\` / `C:/` / `~/` / `/` で始まり区切りが 2 つ以上）、画像のパス）、message の `spec`
   - work（成果物）: tool event の `files`、message の `files`。presented にあるパスは除く
   - シートは「資料」を上、「成果物」を下の別の欄（見出し付き）に並べる。項目の無い欄は見出しごと出さない。見出しの文言は ja「資料」「成果物」/ en "Shared" "Work files"
3. **差分の表示**（ビューア）
   - 変更したファイル（tool event の `files` にあるもの）を開いたら、最初から差分を出す（`since` に `firstAt`）。「全体」で中身に切り替えられる（今の「差分」ボタンの逆）
   - 差分は git の差分の形で描く: 1 行ずつ、`+` で始まる行は追加の色の背景、`-` は削除の色、`@@` の行と `diff --git`・`index`・`---`・`+++` のヘッダは控えめな色。等幅。行は折り返す（横にはみ出さない）
   - 差分が空なら「変更なし」と出して中身を表示する
4. **役割の定型文**（`src/context/role-instructions.ts` の画像の文）: 「人に見せたいファイル（画像に限らない）は、最終応答に `[名前](<フルパス>)` で書く。成果物の『資料』の欄に出る」を足す（英語）
5. 文言は短く。「この〜」の言い回しは使わない

## テスト方針

- `file-preview.test.ts`（一時の git リポジトリで）: `since` の前のコミットからの差分（コミット済み＋未コミット）、`since` より前のコミットが無い、未追跡のファイル、変更なし、`since` が不正
- `artifacts.test.ts`: 最終応答・message 本文のリンクと絶対パスと spec が presented、tool の files が work、両方にあるものは presented だけ、途中の発言のパスは対象外、`firstAt`
- 差分の行の分類（追加・削除・区切り・ヘッダ）を純粋な関数にしてテストする
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、一時の git リポジトリを開き、ファイルを変更してコミットした状態と未コミットの状態の差分、2 つの欄を確かめ、スクリーンショットの path を RESULT に書く
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
