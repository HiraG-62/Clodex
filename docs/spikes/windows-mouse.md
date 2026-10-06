# Spike I — Windows の Node にマウスのホイールを届ける

実施日: 2026-10-06 / Windows 11 Pro 10.0.26200 / Node 22.13.1 / node-pty（ConPTY）

## 問い

TUI は代替画面でマウスの報告（`ESC[?1000h` + SGR `ESC[?1006h`）を有効にしてホイールでスクロールする。Windows Terminal からのホイールは Node の stdin に届くか。

## 方法

`spikes/mouse-conpty.ts` が node-pty（ConPTY。Windows Terminal と同じ経路）で子の Node を起動し、入力として VT のシーケンスを書き込む。子は stdin に届いたものをそのまま出す。

- `spikes/mouse-child.mjs`: `setRawMode(true)` だけ
- `spikes/mouse-child-vt.mjs`: `setRawMode(true)` の後、別プロセス（PowerShell の P/Invoke）で標準入力のコンソールモードに `ENABLE_VIRTUAL_TERMINAL_INPUT`（0x200）を足す
- `spikes/mouse-conpty-keys.ts`: 両者でキー入力の届き方を比べる

## 結果

| 入力 | raw mode だけ | + `ENABLE_VIRTUAL_TERMINAL_INPUT` |
|---|---|---|
| ホイール上 `ESC[<64;10;5M` / 下 `ESC[<65;10;5M` | **届かない** | そのまま届く |
| PageUp / PageDown | `ESC[5~` / `ESC[6~` | 同じ |
| ↑ / ← / Enter / Ctrl+C / Ctrl+J / Ctrl+O / Ctrl+D / 日本語 | 同じ | 同じ |
| Backspace | `\b` | `\x7f` |
| Ctrl+End | `ESC[4;5~` | `ESC[1;5F` |

- Node 22 の `setRawMode(true)`（libuv の `UV_TTY_MODE_RAW`）は Windows ではコンソールの入力レコードからキーだけを VT に変換し、マウスのレコードは捨てる
- 同じコンソールにつながった別プロセスから `SetConsoleMode` で 0x200 を足すと、ConPTY は入力を VT のまま渡し、マウスの SGR シーケンスも届く。コンソールモードは入力バッファ単位なので、別プロセスから変えても Node 側に効く（モードは 8 → 520）
- 違いが出た Backspace と Ctrl+End は、どちらも Ink が同じキーとして解釈する形（xterm 標準）

## 設計への影響

- TUI は Ink が raw mode に入った後に、標準入力のコンソールモードへ `ENABLE_VIRTUAL_TERMINAL_INPUT` を足す（DESIGN.md D4）
- libuv の `setRawMode` はモードを設定し直すので、raw mode を入れ直すと 0x200 は外れる。足すのは raw mode に入った後
