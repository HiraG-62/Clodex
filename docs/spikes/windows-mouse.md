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

## 追試: 実際の TUI でホイールが効かなかった（2026-10-06）

VT 入力モードを足しても、実際の TUI ではホイールが効かなかった。原因は 2 つ。

### 1. ConPTY は VT 入力モードの前に出したマウスの設定を端末へ渡さない

`spikes/mouse-mode-passthrough.ts` で、ConPTY が端末向けに出すモードの設定を見た。

| 子の動き | 端末へ出たモード |
|---|---|
| `?1000h` / `?1006h` を出す（VT 入力モードなし） | `?9001h ?1004h ?25l ?25h`（マウスの設定は出ない） |
| VT 入力モードを足してから `?1000h` / `?1006h` を出す（`spikes/mouse-order-child.mjs`） | `… ?1000h ?1006h` |

TUI は起動直後にマウスの設定を出し、VT 入力モードは後から非同期で足していたため、Windows Terminal はマウスの報告を始めなかった（ホイールもクリックも届かない）。

→ マウスの設定は VT 入力モードを足し終えてから出す。

### 2. Ink 8 は SGR マウスのシーケンスを useInput に渡さない

`spikes/tui-mouse.ts`（実際の `startTui` を ConPTY で動かす）と `spikes/ink-mouse-drop.ts` で確かめた。stdin にはホイールのシーケンスが届いているが、`useInput` は呼ばれない。Ink 8 の `components/App.js` は、完全な CSI のうちキー名の無いもの（フォーカス・カーソル位置の応答・マウスなど）を `useInput` に渡す前に捨てる。

→ stdin と Ink の間に中継の stream を置き、SGR マウスのシーケンスだけを抜き出して TUI に渡す。残りを Ink に渡す。
