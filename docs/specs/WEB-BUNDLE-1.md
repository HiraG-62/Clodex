# WEB-BUNDLE-1: Web UI のクライアントを esbuild で bundle する（構成の置き換えだけ）

仕様は docs/DESIGN.md §17 Web UI の「クライアントの組み立て」（今回追記済み）。この段階では、組み立て方だけを置き換える。`client-main.ts` の中身の分割と描画の改善は次の spec（WEB-BUNDLE-2 以降）で行う。**画面の見た目と振る舞いは変えない。**

## 現状

- `src/web/web-page.ts` が、`clientMain` と純関数のソースを `toString()` で HTML に埋め込み、`ClientDeps` として引数で渡している。純関数を足すたびに、`ClientDeps` の型・引数の分割代入・`FUNCTIONS` の文字列の 3 か所を揃える必要がある
- tsx で動かすと `__name` が入るので、`NAME_SHIM` で逃げている
- `marked` は UMD のビルドを別の `<script>` で埋め込んでいる（`MARKED_UMD`）
- CSS は `web-page.ts` の中の約 760 行の文字列（`STYLE`）

## 変更

1. **入口**: `src/web/client/index.ts` を作る。ページの `<script type="application/json" id="clodex-config">` から、今 `deps` で JSON として渡している値（`layout`・`commands`・`messages`・`version`）を読み、`clientMain` を呼ぶ
   - `clientMain` は、純関数を引数ではなく普通の `import` で使うように変える。`ClientDeps` は JSON で渡す値だけにする
   - `markdown.ts` は `marked` を `import` する（グローバルの `marked` を使っていればそれをやめる）
2. **CSS**: `STYLE` を `src/web/client/style.css` に移す。`${...}` で値を差し込んでいる箇所があれば、CSS 変数にするか、`web-page.ts` に小さな `<style>` として残す（どちらにしたかを RESULT に書く）
3. **bundle の作り方**: `src/web/client-bundle.ts`（名前は任意）に、bundle と CSS を返す関数を置く
   - 実行中の `web-page` のモジュールと同じディレクトリに `client.js`・`style.css` があればそれを読む（`dist/web/` から動かしたとき）
   - 無ければ esbuild の `buildSync` で `src/web/client/index.ts` を bundle し（`bundle: true`、`format: "iife"`、`write: false`、ブラウザ向けの target。minify はしない）、CSS は `src/web/client/style.css` を読む（`pnpm dev`・テスト）
   - esbuild は devDependency。GUI の本番（`pnpm install --prod`）では読み込まれないよう、2 つ目の経路でだけ `createRequire` などで同期的に読み込む
   - ソースから動かしたときは `src/web/` を見るので、古い `dist` の成果物を使ってしまうことはない
4. **ビルド**: `scripts/build-client.mjs` を作り、`pnpm build` の tsc の後で `dist/web/client.js` と `dist/web/style.css` を書き出す（3 の 2 つ目の経路と同じ esbuild の設定を共有できるなら共有する）
5. **web-page.ts**: `FUNCTIONS`・`CLIENT_SOURCE`・`NAME_SHIM`・`MARKED_UMD`・`STYLE` を消し、3 の関数から得た script と CSS を inline で埋め込む。`</script` のエスケープ（`inlineScript`）は bundle にも使う。設定の JSON は `json()`（`<` のエスケープ）で埋め込む。版の hash は bundle・CSS・HTML・設定の JSON から作る
6. `tsconfig.build.json`: client のモジュールを `dist` に tsc で出す必要が無くなるなら除外してよい。ただし `src/index.ts`・`src/tui/` などサーバー側が import している `src/web/client/` のモジュール（`terminal-layout.ts` などが使っているもの）は残す
7. CLAUDE.md の「画面の確認」はそのままで動くはず（`pnpm dev serve`）。変更が要るなら RESULT に書く（CLAUDE.md は claude が直す）

## テスト

- `src/web/web-page.test.ts`: 今の「埋め込んだ script が構文として正しい」確認を、bundle に対して行う。`toString()` 前提のテストは消すか置き換える。設定の JSON が `</script>` を含む文言でも壊れないこと
- bundle の関数: dist の成果物があればそれを使い、無ければ bundle すること（一時ディレクトリで確かめる）
- 一時の Hub を `pnpm dev serve` と、`pnpm build` 後の `node dist/index.js serve` の両方で起動して、画面がエラー無しで動くことを確かめる（CLAUDE.md の「画面の確認」。build の出力先はリポジトリの外の一時フォルダにする: `pnpm exec tsc -p tsconfig.build.json --outDir <一時>\dist` と `node scripts/build-client.mjs <一時>\dist` のように、出力先を引数で変えられるようにする）。ブラウザのコンソールのエラーが 0 件であることを RESULT に書く

## 変更してよいファイル

- `src/web/web-page.ts`、`src/web/web-page.test.ts`、`src/web/client-bundle.ts`（新規）とそのテスト
- `src/web/client/`（`index.ts`・`style.css` の新規、`client-main.ts`・`markdown.ts` などの import の書き換え）
- `scripts/build-client.mjs`（新規）、`package.json`（esbuild の追加と `build` script）、`pnpm-lock.yaml`、`tsconfig.build.json`、`scripts/stage-gui-runtime.mjs`（変更が要るときだけ）

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
