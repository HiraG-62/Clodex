# Spike H: `!command` のシェル実行

実施日: 2026-10-06 / Windows 11 Pro 10.0.26200 / PowerShell 7（pwsh）と Windows PowerShell 5.1
検証スクリプト: `spikes/shell-command.ts`（`pnpm tsx spikes/shell-command.ts <cwd>`）

## 確認したこと

`-NoProfile -NonInteractive -Command <script>` で、日本語を出す PowerShell のコマンド・native command（`git log`）・`Write-Error`・`exit 3` を実行し、stdout / stderr を UTF-8 として読んだ。

| シェル | 既定 | 先頭に UTF-8 指定を足した場合 |
|---|---|---|
| pwsh 7 | PowerShell の文字列が CP932 で出て文字化け。git の出力は UTF-8 で正常 | すべて正常 |
| powershell 5.1 | 同上。エラーはスクリプト全文付きの長い形式 | すべて正常 |

- UTF-8 指定: `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; `
- pwsh のエラー出力には色の ANSI escape（`\u001b[31;1m` 等）が付く
- 終了コードは `exit 3` がそのまま返る
- 起動時間: pwsh 約 0.6 秒、powershell 5.1 約 0.3 秒
- `taskkill /pid <pid> /T /F` で子プロセス（`ping`）ごと止まり、残らない。`child.kill()` だけではシェルの子プロセスが残りうる

## 設計への反映

- `!command` は pwsh があれば pwsh、無ければ powershell.exe で実行し、先頭に UTF-8 指定を足す（DESIGN.md §8）
- 表示前に ANSI escape を取り除く
- 停止は `taskkill /T /F` でプロセスツリーごと止める
- command の後に終了コードを返す 1 行を足す（下記）

## 追記: native command の終了コード

`-Command` は最後の native command が失敗すると終了コードを 1 に変える（`cmd /c exit 3` → 1。pwsh / 5.1 とも）。command の後に改行して次を足すと、実際の終了コードを返せる。

```powershell
if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }
```

| command | 終了コード |
|---|---|
| `cmd /c exit 3` | 3 |
| `cmd /c exit 0` / `Write-Output ok` | 0 |
| `Get-Item nope`（cmdlet の失敗） | 1 |
| `exit 2` | 2 |
| `cmd /c exit 3; Write-Output after` | 0（最後の文の結果） |
| git の失敗（`git status` を repository 外で） | 128 |
