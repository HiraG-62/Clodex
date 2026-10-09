# ROLE-PRESETS: 役割のプリセットを選べるようにする

仕様は docs/DESIGN.md §13 Roles の「プリセット」（今回追記済み）。

## プリセットの文章

1 つのファイル（例: `src/config/role-presets.ts`）に定数として置く。文言のカタログ（`messages.ts`）には入れない（Agent に渡す文章で、画面の文言ではないため）。表示名（画面に出す短い名前）は `messages.ts` に入れる。

### `design-review`（表示名: ja「設計・レビュー Claude / 実装 Codex」、en "Claude designs & reviews / Codex implements"）

- ja
  - claude: 設計とレビュー、コミットを担当する。設計書を書いてから実装を codex に DELEGATE する。codex の実装は差分を確認し、テストと型チェックを通してからコミットする。数行で済む修正は自分で行ってよい。
  - codex: 実装を担当する。claude の DELEGATE に従ってテストとコードを書き、テストと型チェックを通してから RESULT で報告する。設計に迷ったら claude に QUESTION する。コミットはしない。
- en
  - claude: Own design, review, and commits. Write a spec, then DELEGATE the implementation to codex. Review codex's diff and commit after the tests and type checks pass. You may make fixes of a few lines yourself.
  - codex: Own implementation. Follow claude's DELEGATE: write tests and code, and report with RESULT after the tests and type checks pass. Ask claude with QUESTION when the design is unclear. Do not commit.

### `codex-design`（表示名: ja「設計・レビュー Codex / 実装 Claude」、en "Codex designs & reviews / Claude implements"）

Codex は `edit` の権限では git のコミットができない（GUIDE.md §6）ので、コミットは実装する Claude が担当する。単純な入れ替えにはしない。

- ja
  - claude: 実装とコミットを担当する。codex の DELEGATE に従ってテストとコードを書き、テストと型チェックを通してから RESULT で報告する。codex の承認を受けてからコミットする。設計に迷ったら codex に QUESTION する。
  - codex: 設計とレビューを担当する。設計書を書いてから実装を claude に DELEGATE する。claude の実装は差分を確認し、問題が無ければ RESULT（approved）で承認する。コミットはしない。
- en
  - claude: Own implementation and commits. Follow codex's DELEGATE: write tests and code, and report with RESULT after the tests and type checks pass. Commit after codex approves. Ask codex with QUESTION when the design is unclear.
  - codex: Own design and review. Write a spec, then DELEGATE the implementation to claude. Review claude's diff and approve with RESULT (approved) when it is fine. Do not commit.

### `implement-review`（表示名: ja「実装 Claude / レビュー Codex」、en "Claude implements / Codex reviews"）

- ja
  - claude: 設計と実装、コミットを担当する。まとまった変更を終えたら、コミットの前に codex に REVIEW_REQUEST を送り、指摘を反映してからコミットする。
  - codex: レビューを担当する。claude の REVIEW_REQUEST に対し、差分を読んで、バグ・設計の問題・テストの不足を RESULT の issues で報告する。コードは変更しない。
- en
  - claude: Own design, implementation, and commits. After a sizable change, send a REVIEW_REQUEST to codex before committing, and commit after addressing the findings.
  - codex: Own reviews. For claude's REVIEW_REQUEST, read the diff and report bugs, design problems, and missing tests as RESULT issues. Do not change code.

## 変更

1. `/role preset <name>`: 今の表示言語の文章で、両 Agent の役割を project の `.clodex.json` に保存する（既存の `/role <agent> <text>` の保存処理を使う）。結果の表示は `/role` と同じく「/new {agent} の後に反映」の扱いに揃える。`/role preset` だけなら、プリセットの名前と表示名の一覧を出す。知らない名前はエラー
   - コマンドの引数の候補（`src/cli/commands.ts` の `argumentValues` など）にプリセットの名前を出す
2. state（`WebState`）に、今の役割と一致するプリセットの名前（無ければ無し）を足す。一致の判定は、両 Agent の役割の文章が、どちらかの言語のプリセットの文章と完全に一致するか
3. Web UI の設定のシートの project の節に、プリセットの選択を置く（既存の `settingsChoice` か select。プリセット 3 つ＋一致しないときの「カスタム」）。選ぶと `/role preset <name>` を送る。「カスタム」は選べない表示だけ
4. GUIDE.md の役割の例は claude が直すので触らない

## テスト

- プリセットの文章が ja / en ともに 3 つ揃っていること
- `/role preset <name>` が両方の役割を保存すること、一覧、知らない名前のエラー
- 一致の判定
- 設定のシートの見た目は一時の Hub（`pnpm dev serve`）で確かめ、スクリーンショットを `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存してパスを RESULT に書く

## 変更してよいファイル

- `src/config/role-presets.ts`（新規）とそのテスト、`src/project/role-settings.ts` とそのテスト
- `src/cli/input.ts`・`src/cli/input.test.ts`（`/role preset` の入力の解析）
- `src/cli/commands.ts`・`src/cli/shell.ts`（と REFACTOR-SERVER-1 で切り出した handler のファイル）とそれぞれのテスト
- `src/web/web-feed.ts`・state を作る箇所、`src/web/client/` の設定のシートのモジュールとそのテスト
- `src/i18n/messages.ts`

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
