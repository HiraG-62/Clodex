# D3-GUI-STANDALONE: GUI に Node と Clodex 本体を同梱し、単体で動かす

設計の正は `docs/DESIGN.md` §28「D3 の詳細」。この文書は実装の範囲と受入条件をまとめる。

## 背景

今の GUI（`gui/src-tauri/src/lib.rs` の `spawn_hub`）は PATH の `clodex.cmd` か `CLODEX_GUI_ENTRY` で Hub を起動する。インストーラーだけを入れた PC では Hub を起動できない。

## 変更

1. 同梱物を組み立てるスクリプト（例: `scripts/stage-gui-runtime.mjs`。TypeScript にするなら tsx で動かす）
   - 出力先は `gui/src-tauri/runtime/`。毎回作り直す。`.gitignore` に追加する
   - `runtime/node.exe`: スクリプトを動かしている Node の `process.execPath` をコピーする
   - `runtime/app/`: `package.json`、`pnpm-lock.yaml`、`dist/` をコピーし、その中で `pnpm install --prod --frozen-lockfile --node-linker=hoisted --ignore-scripts` を実行する。hoisted にするのは、resource にコピーするときに pnpm の symlink 構造を避けるため
   - `package.json` の `gui:dev` / `gui:build` を `pnpm build` → このスクリプト → `tauri dev|build` の順にする
2. `gui/src-tauri/tauri.conf.json`
   - `bundle.resources` で `runtime/` 以下をアプリに入れる（`runtime/` が resource の `runtime/` に置かれる形）
3. `gui/src-tauri/src/lib.rs` の `spawn_hub`
   - 起動に使うものの優先順:
     1. `CLODEX_GUI_ENTRY` があれば、今どおり `CLODEX_GUI_NODE`（既定は `node`）で起動する
     2. それ以外は、resource dir の `runtime/node.exe` で `runtime/app/dist/index.js serve` を起動する
   - PATH の `clodex.cmd` へのフォールバックと `CLODEX_GUI_COMMAND` は削除する
   - resource dir は setup の `app.path().resource_dir()` から渡す。パスはマジックストリングにせず定数にする
   - 同梱物が見つからないときは、パスを含むエラーで起動を止める
   - `CREATE_NO_WINDOW`、lock を待つ処理、GUI 終了時に Hub を止める処理は今のまま
   - `clodex.cmd` 経由の起動では lock の pid が子の pid と違うことへの対処を入れてある。node を直接起動するなら一致するはずなので、要らなくなった分岐があれば消す
4. `gui/README.md`: 同梱物の組み立てと環境変数の説明を新しい起動方法に合わせる

## テスト

- 今の Rust 側に単体テストがなければ、新しく足さなくてよい。`cargo check` と `cargo fmt --check` は通す
- TypeScript 側の変更がなければ `pnpm test` と `pnpm typecheck` を通すだけでよい

## 受入条件（codex が実機で確かめて RESULT に書く）

- `pnpm gui:build` が通り、インストーラーの中身（`target/release` 以下の resource）に `runtime/node.exe` と `runtime/app/dist/index.js` が入っている
- 一時的な HOME と、`clodex` と `node` を含まない PATH で、release の `clodex-gui.exe` を起動する。同梱の Node で Hub が起動し、Web UI が開き、フォルダ選択から project を開ける。GUI を閉じると Hub と `hub.lock` が消える
- `runtime/app/node_modules` の大きさとインストーラーの大きさを RESULT に書く
- 実ユーザーの `~/.clodex` には触れない。Agent にメッセージは送らない（E2E はしない）
- `pnpm test`、`pnpm typecheck`、`cargo check`、`cargo fmt --check` が通る
