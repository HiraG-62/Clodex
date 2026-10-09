# MOBILE-CONNECT: スマホで Hub につなぐ URL と QR コードを Web UI に出す

仕様は docs/DESIGN.md §17 Web UI の「接続と認証」の「スマホからの接続の案内」（今回追記済み）。GUI（WebView）でも同じ画面を使うので、PC の GUI に QR コードを出してスマホで読み取る使い方が主になる。

## 手順 1: tailscale の出力の実測（spike）

CLI の挙動に依存するので、先に実測して `docs/spikes/tailscale.md` に記録し、`docs/spikes/README.md` の表に 1 行足す。

- `tailscale status --json` の `BackendState` と `Self.DNSName`（末尾の `.` の有無）
- `tailscale serve status --json` の形。今の PC では次の形だった（claude が確認済み）。Hub のポート（`config` の `web.port`。既定 4319）へ proxy している入口を探す方法を決める
  ```json
  { "TCP": { "443": { "HTTPS": true } },
    "Web": { "<name>.<tailnet>.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:4319" } } } } }
  ```
  - `serve` が未設定のときの出力（`{}` や空など）。この PC の serve の設定は**変えない**（人が使っている）。未設定の出力は、ドキュメント・ソースから分かる範囲で記録し、分からなければ「未実測」と書いてテストは想定の形で書く
  - 443 以外のポートのときの URL の作り方。パス付き（`/clodex` など）の handler は、Web UI がルートからの絶対パス（`/api/...`・`/events`）を使うため動かない。`/` の handler だけを有効とし、パス付きだけなら `noServe` にする
- tailscale が PATH に無いとき: `C:\Program Files\Tailscale\tailscale.exe` を見る。どちらにも無ければ「未導入」
- 実行にかかる時間

## 手順 2: 実装

1. **tailscale の問い合わせ**（`src/web/tailscale.ts` など）: 上の 2 つのコマンドを実行し（shell は使わず、`execFile` 相当。timeout は定数。例: 3 秒）、状態を返す純関数と、実行する部分を分ける
   - 状態: `ready`（URL あり）/ `noServe`（tailscale は動いているが、Hub のポートへの proxy が無い）/ `stopped`（`BackendState` が `Running` 以外）/ `missing`（実行ファイルが無い）
   - JSON の検証は zod で行い、想定外の形は `noServe` ではなく失敗（エラーの文言）として扱う
2. **API**: `GET /api/connect`（token 認証。token なしは 401）が `{ state, url?, qrSvg?, command?, error? }` を返す
   - `url` は `https://<入口>/?token=<token>`。`qrSvg` は `url` の QR コード（`qrcode` パッケージの SVG 出力。色は画面の前景・背景に合わせず黒と白でよい。読み取りやすさを優先）
   - `command` は `noServe` のとき `tailscale serve --bg <port>`
   - `cache-control: no-store`
3. **Web UI**: 設定のシートの Clodex の節に「スマホ」の行を置き、右端に QR コードのアイコンのボタン（文字のボタンにしない。`aria-label`・title は「スマホ」）。押すとシートを開き、`/api/connect` の結果を出す
   - `ready`: QR コード（スマホで読み取れる大きさ。240px 程度）、その下に URL（等幅・折り返し）とコピーのアイコンのボタン
   - `noServe`: 「serve 未設定」と、`command` とコピーのボタン
   - `stopped`:「Tailscale 停止中」、`missing`:「Tailscale 未導入」、失敗: エラーの文言
   - 読み込み中は既存の待ちの表示（スピナー）を使う
   - スマホの画面（自分自身がスマホ）で開いた場合も同じ表示でよい
   - 文言は短く体言止め（CLAUDE.md の UI 文言の方針）。`src/i18n/messages.ts` に ja / en
4. 依存: `qrcode`（`dependencies`）と型（`@types/qrcode` が要るなら devDependencies）

## テスト

- 出力の解釈の純関数: ready（443・パス無し）、別のポート、Hub と違うポートへの proxy だけ（`noServe`）、`Running` 以外（`stopped`）、想定外の形（失敗）
- 実行ファイルの探し方: PATH → 既定の場所 → 無し（実行は注入する）
- `/api/connect`: token なしで 401、ready のとき URL に token が入り、SVG が返ること（tailscale の問い合わせは注入する）
- 一時の Hub（`pnpm dev serve`。CLAUDE.md の「画面の確認」。ポートは 47999 なので、この PC では `noServe` になるはず）で、設定から開いたシートの見た目を確かめる。`ready` の見た目は、問い合わせを差し替えるか、一時の Hub をポート 4319 で起動できない（本物の Hub が使っている）ので、テスト用の差し替えで確かめてよい。スクリーンショット（PC とスマホ幅）を `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存し、パスを RESULT に書く

## 変更してよいファイル

- `docs/spikes/tailscale.md`（新規）、`docs/spikes/README.md`、`spikes/tailscale-*`（新規。要れば）
- `package.json`・`pnpm-lock.yaml`
- `src/web/tailscale.ts`（新規）とそのテスト、`src/web/web-server.ts`・`src/web/web-server.test.ts`、`src/index.ts`（web server に問い合わせの関数を渡すときだけ）
- `src/web/client/` の設定のシートと、新しいシートのモジュールとそのテスト、`src/web/web-icons.ts`、`src/web/client/style.css`
- `src/i18n/messages.ts`

## 確認

- `pnpm test`、`pnpm typecheck`、`pnpm lint` が通ること
