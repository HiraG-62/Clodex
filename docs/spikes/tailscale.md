# Tailscale の状態と Serve の出力

実施日: 2026-10-10 / Windows 11 / `C:\Program Files\Tailscale\tailscale.exe`

この PC の Serve 設定は変更していない。コマンドは読み取り専用の `status --json` と `serve status --json` のみ実行した。

| コマンド | 所要時間 | 結果 |
|---|---:|---|
| `tailscale status --json` | 61 ms | `BackendState: "Running"`。`Self.DNSName` は `desktop-….ts.net.` のように末尾に `.` が付く |
| `tailscale serve status --json` | 23 ms | `TCP.443.HTTPS: true`。`Web["desktop-….ts.net:443"].Handlers["/"].Proxy: "http://127.0.0.1:4319"` |

この環境では CLI が PATH から見つかった。PATH に無い場合の既定の場所は `C:\Program Files\Tailscale\tailscale.exe`。`serve` 未設定時の出力は実測していない。テストでは `{}` を未設定の想定形とする。

Hub のポートへの入口は `Web` の各 HTTPS エントリにある `Handlers["/"]` の `Proxy` を調べて選ぶ。443 の入口は URL のポートを省き、ほかのポートは明示する。`Self.DNSName` の末尾の `.` は URL に含めない。パス付き handler だけの場合は `noServe` にする。Web UI の API と SSE は `/api/...`・`/events` の絶対パスを使うため。
