# WEB-FONTS: Web UI のフォントを同梱し、Hub から配る

仕様は docs/DESIGN.md §17 Web UI の「クライアントの組み立て」のフォントの行（今回追記済み）。**見た目は今と同じにする**（同じフォント・同じ太さ）。

## 現状

- `src/web/web-page.ts` の `<head>` が Google Fonts の CSS を外部から読んでいる（171〜172 行付近）。使っている太さ: Geist 400/500/600、Geist Mono 400/500、Zen Kaku Gothic New 400/500/700
- `src/web/client/style.css` は `--font-ui: "Geist", "Zen Kaku Gothic New", ...`、`--font-mono: "Geist Mono", "Zen Kaku Gothic New", ...` で参照している

## 変更

1. 依存（`dependencies`。GUI の本番の `pnpm install --prod` に含まれるように）: `@fontsource/geist-sans`・`@fontsource/geist-mono`・`@fontsource/zen-kaku-gothic-new`（5.3.0 があることは確認済み）。font-family の名前がパッケージで違う（例: "Geist Sans"）なら、`style.css` の変数の方を合わせるか、`@font-face` の `font-family` を今の名前で書く
2. `@font-face`: 上の太さの分だけ、各パッケージの CSS（`<weight>.css` など。`unicode-range` で分かれた woff2 を指す）を Hub の起動時に読み、`url(...)` を `/fonts/<パッケージ名>/<ファイル名>` に書き換えて、ページの `<style>` に inline で入れる（`client-bundle.ts` の CSS と同じく、版の hash に含める）
   - CSS の読み込みと書き換えは純関数にしてテストする
   - `font-display: swap` は今の Google Fonts と同じにする
3. 配信: `src/web/web-server.ts` に `GET /fonts/<パッケージ名>/<ファイル名>` を足す
   - token なしで返す（manifest と同じ扱い）
   - 返せるのは上の 3 パッケージの `files/` の下の `.woff2` だけ。パッケージ名は許可リストで照合し、ファイル名は `/`・`\`・`..` を含まないものだけ（パストラバーサルを防ぐ）。それ以外は 404
   - `content-type: font/woff2`、`cache-control: public, max-age=31536000, immutable`。URL にパッケージの版を含める（`/fonts/<パッケージ名>@<版>/<ファイル名>` など）か、それに準じる方法で、版が変わったら別の URL になるようにする
   - パッケージの場所は `import.meta.resolve("<パッケージ名>/package.json")` などで解決する
4. `<head>` の Google Fonts の `<link>`（preconnect を含む）を消す
5. Service Worker（`/sw.js`）がフォントを扱う必要があるかを確認し、要らなければ触らない

## テスト

- CSS の書き換え（`url()` の置き換え、`unicode-range` を保つ）
- `/fonts/...`: 許可したパッケージの woff2 は 200 と正しい header、許可していないパッケージ・`..`・woff2 以外は 404、token なしで返ること
- `web-page.test.ts`: ページに `fonts.googleapis.com` が含まれないこと、`@font-face` が入っていること
- 一時の Hub（`pnpm dev serve`。CLAUDE.md の「画面の確認」）で、今と同じ見た目であること（日本語の本文・等幅の部分を含む）、ネットワークに外部への要求が無いことを確かめる。変更前と後のスクリーンショット（PC）を `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存し、パスを RESULT に書く。ビルド版（一時フォルダへの `pnpm exec tsc -p tsconfig.build.json --outDir <一時>\dist` と `node scripts/build-client.mjs <一時>\dist`）でもフォントが読めることを確かめる

## 変更してよいファイル

- `package.json`・`pnpm-lock.yaml`
- `src/web/web-page.ts`・`src/web/web-page.test.ts`・`src/web/web-server.ts`・`src/web/web-server.test.ts`・`src/web/client-bundle.ts`（CSS の組み立てを共有するときだけ）、`src/web/client/style.css`（font-family の名前を合わせるときだけ）
- `src/web/` の新しいモジュール（例: `fonts.ts`）とそのテスト

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
