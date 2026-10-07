# Clodex GUI

Windows の Tauri v2 アプリ。`pnpm gui:dev` は TypeScript のビルドと同梱物の組み立て後に GUI を起動する。`pnpm gui:build` は同じ手順で Windows 用の配布物を作る。

`scripts/stage-gui-runtime.mjs` は `gui/src-tauri/runtime/` を毎回作り直し、実行中の Node を `node.exe` としてコピーする。`app/` に `package.json`、`pnpm-lock.yaml`、`dist/` をコピーし、本番用の依存関係を frozen lockfile・hoisted・install scripts 無効でインストールする。配布物にはこのディレクトリ全体が入り、PATH に Node や `clodex` がなくても動く。

GUI は生きている `~/.clodex/hub.lock` があればその Hub を使う。無ければ同梱の `runtime/node.exe` で `runtime/app/dist/index.js serve` を起動する。同梱ファイルがなければ、そのパスを含むエラーで停止する。開発中は `CLODEX_GUI_ENTRY` に手元の `dist/index.js` のフルパスを指定すると優先して使う。この場合の Node は `CLODEX_GUI_NODE` で指定でき、既定は PATH の `node`。

ウィンドウを閉じると GUI はトレイに残り、Hub と Agent は動き続ける。トレイの左クリックか「開く」でウィンドウを再表示し、「終了」で GUI を終了する。もう一度起動した場合も既存のウィンドウを表示する。

GUI の終了時に、GUI が起動した Hub を停止する。既に動いていた Hub は停止しない。Agent へのメッセージは GUI の起動だけでは送らない。

ウィンドウが非表示かフォーカスを失っているとき、作業終了・通知・エラーを Windows の通知に表示する。履歴の読み込みでは通知しない。

## 更新と公開

GUI は起動時とトレイの「更新を確認」で、GitHub Releases の `latest.json` を確認する。新しい版があれば確認のダイアログを出し、「更新」でダウンロードして署名を検証する。その後、GUI が起動した Hub を止めて、インストーラーを passive で実行する。インストールが終わると GUI が起動し直す。

公開の手順:

1. `package.json` の `version` を上げて commit する（`tauri.conf.json` はこの版を使う）
2. `git tag v<version>` を作り、commit と tag を push する
3. `.github/workflows/release.yml` が Windows でビルドし、インストーラー・`.sig`・`latest.json` を Release に上げる

署名の秘密鍵は GitHub の Secret の `TAURI_SIGNING_PRIVATE_KEY`（パスワードは `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）に置く。公開鍵は `tauri.conf.json` の `plugins.updater.pubkey`。更新用の成果物は `tauri.release.conf.json` を渡したときだけ作るため、手元の `pnpm gui:build` に秘密鍵は要らない。
