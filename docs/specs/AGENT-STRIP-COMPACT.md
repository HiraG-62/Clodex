# AGENT-STRIP-COMPACT: Agent ストリップを「畳む + リング化」で 3 体に耐える形にする

## 背景

gemini を足して PC の Agent ストリップが 3 枚になり、カードの文字（「コンテ」「5 時間」「週」のラベルとゲージ・%）が詰まって読めない。人の決定: 停止中の Agent を畳み、ゲージの文字ラベルをやめてリングとアイコンにする。

仕様の正は `docs/DESIGN.md` §17「画面」の PC の「Agent ストリップ」の項（claude が更新済み。触らない）。対象は PC の Web UI だけ。スマホのピル・シート、TUI、幅 1700px 以上の右端の利用状況パネルは変えない。

## Fixed

### カードの 2 つの形

- **展開カード**（`stopped` でない Agent と、送り先に選んでいる Agent と、手動で展開した Agent）
  - mark に、スマホの Agent ピルと同じ重ね（コンテキストの円環・状態の点・`full` のときの盾）を付ける（部品は流用か共通化。二重実装にしない）
  - 名前・状態 pill・model / effort / 権限のチップ・中断 / Compact / 設定のアイコンは今のまま
  - 「コンテ」「5 時間」「週」の文字ラベル・横のミニゲージ・% の文字を消し、利用枠は**小さな円環 2 つ**（5 時間・週）にする。円環の中にアイコン（時計 / カレンダー。既存の `<symbol>` に無ければ Lucide 相当の線のアイコンを足す）。使用率は円環の弧で示し、数値は `aria-label` と title（「5 時間 34% · reset 14:00」の形）に。警告の閾値（既存の usageAlert の色の決まり）はリングの色で示す。値の無い Agent（gemini）は薄い無値のリング
  - 適用待ち（§17「待ちの表示」の適用待ちの印）・subagent の印（§28）は今のまま出ること
- **畳みタイル**（`stopped` かつ送り先でなく、手動の展開も無い Agent）
  - mark（円環・状態の点つき）だけの細いタイル。幅は押せる 44px 以上。名前・状態は `aria-label` と title
  - 押すと展開（トグル）。もう一度押すか、会話・project の切り替えで畳みに戻る。手動の展開は `store` の画面の状態（localStorage に保存しない）
- グリッドの列: 展開は `1fr`、畳みは固定幅。`--agent-count` の一律 repeat をやめ、カードの形に応じて組む
- 円環（mark・利用枠）を押すと、今のミニゲージと同じ利用状況のポップオーバーを開く（中身・閉じ方は変えない）。1700px 以上でポップオーバーを開かない今の決まりも保つ

### 変えないもの

- スマホのレイアウト（ピル・シート）、TUI、右端の利用状況パネルの中身
- ポップオーバー・設定ポップアップの中身
- state の形（表示の組み立てだけで実装できるはず。必要になったら QUESTION）

### 編集してよいファイル

- `src/web/client/agent-strip.ts`、`src/web/client/state-view.ts`、`src/web/client/store.ts`、`src/web/client/style.css`、`src/web/web-page.ts`（skeleton・`<symbol>`）と、その test
- `src/i18n/messages.ts`（ラベル文言の削除・aria 用の追加）
- スマホのピルの円環と共通化するためのファイル（既存の実装がどこにあるかは探す）

## Discretion

- 円環の SVG の実装・大きさ・間隔などの CSS の細部（§17「部品」の質感・状態の決まりに従う: hover / focus-visible、120ms、`prefers-reduced-motion`）
- 手動展開の持ち方
- テストの粒度。最低限:
  - stopped + 非送り先 → 畳み、busy / idle / 送り先 / 手動展開 → 展開
  - タイルのトグルと、会話の切り替えで解除
  - 円環の aria-label に % と reset が入る。値の無い Agent は無値の表示
  - ポップオーバーが円環から開く
  - 既存の全テストが通る

## 完了の条件

- `pnpm test`・`pnpm typecheck`・`pnpm lint`・`pnpm build` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く（画面の撮影は claude が行う）
