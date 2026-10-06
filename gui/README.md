# Clodex GUI

Windows の Tauri v2 アプリ。`pnpm gui:dev` は TypeScript のビルドと同梱物の組み立て後に GUI を起動する。`pnpm gui:build` は同じ手順で Windows 用の配布物を作る。

`scripts/stage-gui-runtime.mjs` は `gui/src-tauri/runtime/` を毎回作り直し、実行中の Node を `node.exe` としてコピーする。`app/` に `package.json`、`pnpm-lock.yaml`、`dist/` をコピーし、本番用の依存関係を frozen lockfile・hoisted・install scripts 無効でインストールする。配布物にはこのディレクトリ全体が入り、PATH に Node や `clodex` がなくても動く。

GUI は生きている `~/.clodex/hub.lock` があればその Hub を使う。無ければ同梱の `runtime/node.exe` で `runtime/app/dist/index.js serve` を起動する。同梱ファイルがなければ、そのパスを含むエラーで停止する。開発中は `CLODEX_GUI_ENTRY` に手元の `dist/index.js` のフルパスを指定すると優先して使う。この場合の Node は `CLODEX_GUI_NODE` で指定でき、既定は PATH の `node`。

GUI が起動した Hub は GUI を閉じると停止する。既に動いていた Hub は停止しない。Agent へのメッセージは GUI の起動だけでは送らない。
