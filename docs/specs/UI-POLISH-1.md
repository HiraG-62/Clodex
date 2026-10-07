# Web UI の細かい調整 1

DESIGN.md §17（「部品」「レイアウト」）の更新分を実装する。

## 1. `!command` の入力中の見た目

- 今: 入力欄の上に `#shell-input-label`（「コマンド」）の行が出て、入力欄全体の高さが変わり、ログが押し上げられる
- 変更:
  - `#shell-input-label` の行をなくす
  - `.composer.shell-input` のとき、`--accent` を送り先に関係なく `--code`（緑）にする。入力欄の縁・focus の縁・送信ボタンが緑になる
  - PC: 送り先の切り替え（`.to`）の位置に、同じ高さの「コマンド」の印（terminal アイコン + 「コマンド」。`.to` と同じ「くぼみ + 浮き」で、点は緑）を出し、切り替えは隠す
  - スマホ: 送り先の mark ボタンの位置に、同じ大きさの緑の terminal アイコンを出す
  - 入力中に `!` を消したら元の送り先の表示と色に戻る
- 完了条件: `!` を打つ前後で入力欄と `.log` の高さ・位置が変わらない（Playwright で `getBoundingClientRect` を比べる）

## 2. 設定の表示を押せなくする

- PC の Agent ストリップの `.strip-summary`（model · effort · 権限）と、スマホの Agent シートの `.setting-chip` を、`button` から表示だけの要素にする（hover・cursor・focus なし）
- 設定のポップアップを開くのは、Agent カードの設定アイコンとスマホのシートの「設定」ボタンだけ
- 適用待ち（`.pending`）の見た目と `title` は残す

## 3. 利用状況のポップオーバー（PC）

- Agent ストリップのミニゲージ（`.mini-gauges`）を 1 つのボタンにし、押すとそのカードの下にポップオーバーを開く。もう一度押す・外をクリック・Esc で閉じる。同時に開くのは 1 つ
- 中身（スマホの Agent シートのゲージと同じ部品を使ってよい）:
  - コンテキスト: 使用量 / 上限（例 `128k / 400k`）と %
  - 5 時間: 使用率 %、reset 時刻
  - 週: 使用率 %、ペース（例 `+6`）、reset 時刻
  - 値が無いものは「—」の 1 行
- `state` が届いたら、開いたまま値だけ更新する（作り直して閉じない）
- ミニゲージのボタンには hover の見た目と `title`・`aria-label`（「利用状況」）、`aria-expanded`
- 見た目は `--shadow-pop` の浮いたパネル、角丸 `--r-outer`、矢印なし。幅はカードと同じ

## テスト

- HTML の構造で確かめられるもの（`#shell-input-label` が無い、設定の表示が button でない、ミニゲージが `aria-expanded` を持つ）は `web-page.test.ts` に足す
- 見た目は Playwright で、稼働中の Hub（4319）は使わず fixture で撮る。PC 1440 とスマホ 390 で、`!` の入力前後、ポップオーバーを開いた状態のスクショを RESULT に付ける
- `pnpm test` と `pnpm typecheck` を通す。文言は `src/i18n/messages.ts` の en / ja 両方
