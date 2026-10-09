# LINT-FORMAT: biome で lint と format を入れる

人の判断で lint と format の両方を入れる（全ファイルを整形する大きなコミットが 1 つ入ることは了承済み）。**整形と lint の修正で振る舞いは変えない。**

## 手順とコミットの単位

コミットは claude が次の 3 つに分けるので、RESULT ではそれぞれの変更を分けて書く。作業の途中でも、1 → 2 → 3 の順に、前の段階の変更が混ざらないよう進める（各段階の終わりで `pnpm test`・`pnpm typecheck` を通す）。

1. **設定**: `@biomejs/biome`（2.5 系）を devDependency に入れ、`biome.json` を置く。`package.json` に scripts を足す
   - `"lint": "biome check ."`（lint と format の確認。書き換えない）
   - `"format": "biome check --write ."`（format と、安全な lint の自動修正）
   - `"check": "biome check . && pnpm typecheck"`
2. **整形だけ**: `pnpm format` を実行した結果だけ。手で直す変更は入れない。ただし、整形でソースの字面が変わったことで落ちるテスト（生成した JS や CSS の文字列を比べているもの）は、期待値をこの段階で直してよい。直したテストを RESULT に書く
3. **lint の修正**: 自動で直せなかった lint の指摘を手で直す。直すと振る舞いが変わりうるもの、直すべきでない（規則が合わない）ものは、規則を設定で off にするか、その行に `biome-ignore` と理由を書く。off にした規則と理由を RESULT に書く

## biome.json の方針

- 対象は `src/`・`scripts/`・`gui/` の TypeScript・JavaScript・JSON・CSS。`spikes/` は実測用の使い捨てのコードなので対象外。CSS は lint だけにして format の対象から外す（1 行 1 ルールの今の書き方を保つ）。`dist`・`node_modules`・`gui/src-tauri/target`・`gui/src-tauri/runtime`・`pnpm-lock.yaml`・`docs/` は除く。`.gitignore` を使う設定（`vcs.useIgnoreFile`）にする
- format は今の書き方に近づけ、差分を小さくする
  - インデントはスペース 2、文字列はダブルクォート、セミコロンあり、末尾のカンマは今のコードに多い方
  - 行の長さ: 今のコードは 140 文字を超える行が多い（`src/` で約 680 行）。`lineWidth` は 160 とし、差分の量を見て、整形で読みにくくなる箇所が多いなら RESULT で報告する（claude が値を決め直す）
- lint は `recommended` を基本にする。プロジェクトのルール（CLAUDE.md）に合わせて次を確かめる
  - `noExplicitAny` は error のまま（`any` は使わない）
  - 非 null アサーション（`!`）は今のコードで多用している。`noNonNullAssertion` は off にしてよい
  - そのほか、今のコードの書き方と合わない規則で、直すと大量の変更になるものは off にして理由を書く
- エディタの設定ファイル（`.vscode` など）は足さない

## そのほか

- CI（`.github/workflows/release.yml`）のテストの前に `pnpm lint` を足す
- CLAUDE.md のコマンドの一覧は claude が直すので触らない

## 変更してよいファイル

- `package.json`・`pnpm-lock.yaml`・`biome.json`（新規）・`.github/workflows/release.yml`
- 2・3 の段階では、biome の対象のすべてのファイル

## 確認

- 各段階で `pnpm test`・`pnpm typecheck`、3 の後で `pnpm lint` が通ること
