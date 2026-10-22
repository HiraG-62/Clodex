# TAB-KEEP: タブの固定を会話のピン止めから分ける

## 背景

今はタブに出る会話が「会話の一覧でピン止めした会話」と同じで、タブの × はピン止めを外し、タブの pin は `/pin` する。人は「一覧の先頭に置きたい会話」と「タブに残したい会話」を別に決めたい。

仕様の正は `docs/DESIGN.md` §28 D2a の「**タブ**」の項、§8 のコマンド表の `/tab`、§17 画面の会話の一覧の「⋯」、§18 の保存の枠（claude が更新済み。触らない）。

## Fixed

- 会話の保存（会話の一覧の `.json`。`pinned` を持っているところ）に `tabbed?: boolean` を足す
  - 読み込みで `tabbed` が無い会話は `tabbed = pinned`（分ける前はピン止めがタブだったため）。書くときは `tabbed` を書く
  - 保存の枠（最大 20 件）は、`pinned` か `tabbed` の会話を枠に数えない
- タブ（`state.tabs`）に出すのは、全プロジェクトの `tabbed` の会話と今の会話。並びは今どおり（プロジェクトの一覧の順、その中は会話の一覧の順、固定していない今の会話は末尾）
  - `state.tabs` の要素の `pinned` を `tabbed` に置き換える（ピン止めはタブに出さない）
  - 会話の一覧の項目（state の会話の一覧）にも `tabbed` を入れる
- コマンド: `/tab <id> <root>`（切り替え）は今どおり。`/tab unpin` を消し、`/tab keep <id> <root>`（`tabbed = true`）と `/tab close <id> <root>`（`tabbed = false`）にする。どちらもピン止めを変えない。開いていないプロジェクトは保存してある一覧を書き換える（今の unpin と同じ）
  - コマンドの候補・ヘルプ（i18n の文言を含む）も合わせる
- `/pin` はピン止めだけを切り替え、タブの固定を変えない
- Web UI
  - 固定したタブの × は `/tab close`。固定していない今の会話のタブの pin アイコンは `/tab keep`（`aria-label`・title「タブを固定」/ "Keep tab"）。まだ保存されていない新しい会話には出さない（今どおり）
  - 会話の一覧の「⋯」のメニューに「タブに固定」/「タブの固定を解除」（en: "Keep as tab" / "Remove tab"）を足す。押すと `/tab keep|close <id> <今の project root>`
  - 会話の一覧のピンのアイコンは今どおりピン止めだけを示す
- TUI・CLI でタブを扱っている箇所（`src/tui/tui.ts`、`src/cli/` など）も `tabbed` に合わせる

### 編集してよいファイル
- `src/hub/`、`src/project/`（会話の保存と一覧）、`src/web/`（`client/` を含む）、`src/tui/`、`src/cli/`、`src/index.ts` の、タブとピン止めに関わる箇所と、その test
- `src/i18n/messages.ts`

## Discretion
- 保存の型・state の型の置き場所
- メニューの項目の並び（ピン止めの隣が自然）
- テストの粒度。最低限、次を確かめる
  - ピン止めとタブの固定が互いに影響しない（`/pin` でタブが変わらない、`/tab close` でピン止めが変わらない）
  - `tabbed` の無い保存は `pinned` を初期値にする
  - 保存の枠で `tabbed` の会話が消えない
  - `/tab keep` / `/tab close` が開いていないプロジェクトの会話でも保存を書き換える

## 完了の条件
- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く（画面の撮影は claude が行う）
