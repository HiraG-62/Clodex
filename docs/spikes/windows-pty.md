# Spike C — Windows PTY

スクリプト: `spikes/pty.ts`（node-pty 1.1.0、`useConpty: true`、powershell.exe）

## 検証結果

| 項目 | 結果 |
|---|---|
| ConPTY / node-pty | win32-x64 の prebuild が同梱されており、ネイティブビルド不要（pnpm の build script は無視してよい） |
| stdout | ANSI エスケープ付きで受信できる |
| stdin | `write("...\r")` でコマンド実行できる |
| stderr | PTY では stdout と混ざる（分離不可） |
| ANSI | PSReadLine の色付け・カーソル移動・予測入力表示がそのまま流れてくる。解釈には terminal emulator（xterm-headless 等）が必要 |
| resize | `resize(60, 20)` 後、`$Host.UI.RawUI.WindowSize.Width` が 60 を返した |
| Ctrl+C | `write("\x03")` で実行中の `ping` が止まり、shell は生きたまま |
| process termination | `kill()` で終了（exitCode -1073741510 = STATUS_CONTROL_C_EXIT）。ただし node-pty の子プロセス（conpty_console_list_agent）が `Error: AttachConsole failed` を stderr に出す。親プロセスへの影響はなし |
| Unicode / 日本語 | `[Console]::OutputEncoding=UTF8` 後、日本語が正しく受信できた |

## 結論

PTY 自体は Windows で実用可能。ただし Spike A / B の結果、Agent は構造化 stdio で制御できるため、**Agent Adapter では PTY を使わない**。PTY は将来の Process Manager（dev server 等）で必要になったときに使う。
