# Clodex GUI

Windows の Tauri v2 アプリ。`pnpm gui:dev` は TypeScript をビルドしてから GUI を起動する。`pnpm gui:build` は Windows 用の配布物を作る。

GUI は生きている `~/.clodex/hub.lock` があればその Hub を使う。無ければ PATH の `clodex serve` を起動する。開発中など PATH に `clodex` がないときは、`CLODEX_GUI_ENTRY` に `dist/index.js` のフルパスを指定する。必要なら `CLODEX_GUI_NODE` で Node の実行ファイルも指定できる。`CLODEX_GUI_COMMAND` は PATH のコマンド名を変える。

GUI が起動した Hub は GUI を閉じると停止する。既に動いていた Hub は停止しない。Agent へのメッセージは GUI の起動だけでは送らない。
