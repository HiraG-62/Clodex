# adopt-prompt-icon: 採用したアイコンを GUI と Web に適用する

設計は `docs/DESIGN.md` §28 の「アイコン:」（D 系の PWA の記述の直後）。

## 元の画像

- 採用案: `gui/icon-proposals/02-prompt-black.png`（1254px、四隅は透明）
- 図柄: 黒の角丸の四角、左に橙（約 `#E0A262`）の右向き記号、中央に橙の角丸の小さな四角、右に青（約 `#7BA3DC`）の左向き記号。記号は線端が丸い太い「>」「<」
- 色は PNG から実測して定数にする（中央 `(627,627)` は `(222,161,97)`）

## 作るもの

1. `gui/icon.svg` を採用案の図柄で描き直す（`viewBox="0 0 512 512"`）
   - 角丸の四角は今と同じく 512 いっぱい。角の丸みは採用案の比率に合わせる。四隅は透明
   - 記号は `<path>`（stroke の `stroke-linecap/linejoin="round"` でよい）と `<rect rx>` で描く。`<text>` は使わない（フォントに依存させない）
   - 採用案の PNG と並べて見比べ、位置・太さ・比率を合わせる
2. `gui/icon-ios.svg`: `gui/icon.svg` と同じ図柄で、背景を四隅まで黒で塗ったもの（角丸なし）
3. GUI のアイコン: `gui/` で `pnpm exec tauri icon icon.svg` を実行し `gui/src-tauri/icons/` を作り直す。`tauri.conf.json` の参照は変えない（同じファイル名で生成される）。不要な生成物（今の `icons/` に無いもの）が増えたら消さずに報告する
4. Web
   - `src/web/web-page.ts` の `ICON_SVG` を `gui/icon.svg` と同じ内容にする（改行の有無以外は一致）
   - `MANIFEST` の `background_color`・`theme_color` と `<meta name="theme-color">` を `#000000` にする
   - `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` を head に足す
   - `gui/icon-ios.svg` から 180px の PNG を作る（例: `pnpm exec tauri icon icon-ios.svg -p 180 -o <一時ディレクトリ>`）。base64 にして `src/web/apple-touch-icon.ts` の定数 `APPLE_TOUCH_ICON_PNG_BASE64` に置く
   - `src/web/web-server.ts`: `GET /apple-touch-icon.png` を token なしで返す（`content-type: image/png`。manifest・`/icon.svg` と同じ場所）

## テスト

- `src/web/web-server.test.ts`: `/apple-touch-icon.png` が token なしで 200、`image/png`、PNG の signature で始まり、IHDR の幅・高さが 180
- `src/web/web-page.test.ts`（無ければ既存の page のテストに）:
  - `ICON_SVG` が `gui/icon.svg` の内容と一致する（前後の空白を除いて比較。ずれ防止）
  - `ICON_SVG` に `<text` を含まない
  - html に apple-touch-icon の link があり、theme-color が `#000000`
- `pnpm test` と `pnpm typecheck` を通す

## 範囲外

- `gui/icon-proposals/` の扱い（commit するかは claude が人に確認する）。触らない
- Android 向けの PNG の manifest アイコン（iPhone で使うため今は SVG のみ）

## 報告

- 生成・変更したファイルの一覧
- `gui/icon.svg` を PNG にしたもの（例: 256px）を `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に置き、パスを書く（見比べに使う）
