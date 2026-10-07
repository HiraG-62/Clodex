# GUI の自動更新（2026-10-08）

スクリプト: `spikes/updater/`。Tauri 2.12.1 と `tauri-plugin-updater` 2 で、NSIS のインストーラーを使い Windows 11 で実測した。いま使っている Clodex（`%LOCALAPPDATA%\Clodex`）に触れないよう、`spike.conf.json` で productName を `ClodexSpike`、identifier を別にした。さらに `USERPROFILE` を一時ディレクトリにし、その `.clodex/config.json` で `web.port` を 4329 にした（既定の 4319 だと動いている Hub と衝突して `EADDRINUSE` になる）。

## 手順

1. `spike.conf.json` に `version` を足した設定で 0.0.1 と 0.0.2 をビルドする（`TAURI_SIGNING_PRIVATE_KEY` に秘密鍵のパス、`--config` には絶対パスを渡す。相対パスは `gui/` から解決されず失敗した）
2. 0.0.1 を `/S` でインストールする（Git Bash から実行するときは `MSYS_NO_PATHCONV=1` を付ける。付けないと `/S` がパスに変換され、silent にならずセットアップの画面が出る）
3. `node serve.mjs out/ClodexSpike_0.0.2_x64-setup.exe 0.0.2` で `latest.json` とインストーラーを配る（http なので `dangerousInsecureTransportProtocol` が要る）
4. 隔離した `USERPROFILE` で 0.0.1 を起動し、`click-update.ps1` で確認のダイアログの「更新」を押す

## 結果

- 起動時の確認で `latest.json` を取得し、「Clodex 0.0.2 に更新しますか？ / 作業中のターンは止まります / 更新 / 後で」の TaskDialog が出た
- 「更新」を押すと、インストーラーをダウンロードし、GUI が起動した Hub（同梱の `node.exe`）を止めた。その後、インストーラーが `/P /UPDATE /R /ARGS` で起動し、5 秒以内に GUI のプロセスが終わった
- 約 15 秒後に、インストーラーが新しい GUI を起動した（`/R`）。GUI は新しい同梱の `node.exe` で Hub を起動し直した。環境変数（`USERPROFILE`）は引き継がれた
- 入れ替え後の exe と、アンインストール情報の版はどちらも 0.0.2。起動し直した GUI も `latest.json` を確認したが、同じ版なのでダイアログは出なかった
- `createUpdaterArtifacts` を付けない通常の `tauri build` は、秘密鍵がなくても成功した。付けたビルドでは `.sig` が作られる
- TaskDialog のボタンは UI Automation では Pane に見え、Invoke に対応しない。自動で押すときは、フォーカスを当てて Enter を送る

## 結論

`tauri-plugin-updater` で、ダウンロード、署名の検証、passive のインストール、再起動まで一続きで動く。止める必要があるのは、GUI が起動した Hub だけ。再起動は NSIS の `/R` が行うので、`tauri-plugin-process` は要らない。
