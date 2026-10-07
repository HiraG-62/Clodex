# Web UI 改善の実装（UI-REVAMP）

DESIGN.md §17「画面」（レイアウト・部品・待ちの表示・使い勝手の決まり）を実装する。課題の一覧は `docs/specs/UI-REVAMP-AUDIT.md`。

採用案:
- PC: `docs/mocks/ui-revamp/claude.html`（案 A）をベースに、Agent の状態は `docs/mocks/ui-revamp/claude-b.html` の Agent ストリップ（`.strip`）にする。左の列は会話の一覧だけ
- スマホ: `docs/mocks/ui-revamp/claude.html`（案 A）
- モックの CSS・アイコンの `<symbol>`・DOM は流用してよい。モックのデモ用の仕組み（デモパネル、URL の `demo=` など）は持ち込まない

## 進め方

同じファイル（`src/web/web-page.ts`、`src/web/client/client-main.ts`）を触るので、3 段階を順に進める。**段階ごとに RESULT を送り、claude の確認とコミットを待たずに次へ進んでよい**（各 RESULT にその段階の変更ファイルを書く。コミットは claude が段階ごとに分けて行うので、段階をまたいで同じ hunk を混ぜないように、前の段階の RESULT の後に次へ進む）。

### 段階 1: 部品とデザイン言語、PC のレイアウト

- `:root` に token を足す（色は変えない）: 角丸（外 8 / 中 6 / 内 4 / pill）、`--ring`・`--ring-strong`、`--hover-bg`・`--press-bg`、`--accent`（送り先で `--claude` / `--codex`）・`--accent-soft`、`--shadow-pop`、`--ease`
- アイコン: Lucide 相当の線のアイコンを `<symbol>` にまとめて HTML に 1 回だけ埋め込み、`<svg><use href="#i-..."></svg>` で使う。対応表は AUDIT と同じ（folder-open、list-tree、files、settings、messages-square、square-pen、sliders-horizontal、square、fold-vertical、ellipsis、image-plus、arrow-up、x、activity、message-circle-question、pencil、arrow-down、menu など）
- ボタンの 6 状態（hover / 押下 / 選択中 / 押せない / focus-visible / 処理中）を共通のクラスで持つ（例: `.icon-btn`、`.btn`、`.is-loading`）。処理中のスピナーは段階 2 で使うが、見た目はここで作る
- ヘッダ（PC）: project の pill（folder + 名前 + chevron。native の `select` を透明にして重ねる方式でよい）と「project を開く」、右のアイコントレイ（作業中・質問の badge、詳細のトグル、成果物、設定）。`.path` を本文から外す。tooltip は PC だけ、400ms の遅延
- Agent ストリップ（PC）: ログの上にカード 2 枚。状態 pill（作業中は点のパルス + 下線の sweep、起動中は点線の回転、停止は灰）、model / effort / 権限のチップ（`full` は警告色の盾）、コンテキスト / 5 時間 / 週のミニゲージ（4px、角丸、reset 時刻は値の側か `title`）、中断 / Compact / 設定のアイコン。中断は busy のときだけ押せ、hover で `--crit`
- 左の列は会話の一覧だけにする。行全体に背景、今の会話は浮き、⋯ は hover で濃く、作業中の点は、今の会話なら busy の Agent の色（両方なら primary の色）、別の会話は中立色（state に別の会話の Agent が無いため）
- 入力欄: focus の縁と送信ボタンを `--accent` に。送信と画像はアイコン
- シート: PC は scale + fade の 150ms、閉じるは × アイコン。`.seg` を `.to` と同じ「くぼみ + 浮き」に。主ボタンの白黒反転は 1 画面 1 つ
- トースト: 種類のアイコン・影・出入りの動き・×
- 作業中・質問のタブは 0 件なら出さない
- 質問カード: 選択肢を `.to` の言語に（選択中は浮き + 送り先の色の点）、`回答` を主ボタンに
- ログの見た目（`.entry` の構造）は段階 3 で変えるので、ここでは触らない

### 段階 2: 待ちの表示

DESIGN.md §17「待ちの表示」をすべて実装する。

- トップのバー（`body` か `.app` のクラスで on / off）。初回の接続から最初の `state` まで、会話・project の切り替え、`/new`、sandbox の切り替えの間
- `withPending(button, promise)` のような共通の関数で、ボタンを押せなくしてスピナーを出す。対象: 中断、Compact、新しい会話、会話の行（切り替え中）、ピン・削除・名前の変更、送信待ちの編集・取り消し、役割の保存、`/new <agent>`、model の適用、project の選択と「開く」、質問の回答、送信
- 中断は busy が終わるまで「処理中」のまま
- model・effort・権限は「適用待ち」の状態を持ち、`state` で反映されたら外す（今の `pendingPrimary` と同じ形。古い値に戻して見せない）
- skeleton: 最初の `state` までログ・Agent ストリップ・会話の一覧。`#empty` は `state` が来て履歴が空のときだけ出す
- 「起動中…」の仮のターン: 宛先の Agent が `starting` のとき、または `human` の後に `turn_started` が来るまで。ターンの組み立ては `timeline.ts` 側で純粋関数として持つ（テストを書く）
- 再接続: 帯にスピナー。`EventSource` が CLOSED なら「再読み込み」ボタン。再接続直後はログを消さず、最初の `state` で差し替える。再接続時の 200 件はまとめて 1 回描画する
- 前の履歴の読み込み中はログの先頭に行、`hasMore` が false なら何も出さない
- 画像のアップロード中は入力欄の上にチップ。終わるまで送信を止める
- `!command` の実行中は出力の頭に経過時間（`$ cmd` を受けてから `exit` の行まで。サーバーの変更が要るなら state への追加は最小に）
- 版が変わったときは帯を出してから reload
- ファイル候補（`@`）の取得中は候補の欄に読み込み中の行。project が変わったら取り直す

### 段階 3: スマホのレイアウト

DESIGN.md §17 のスマホの項目どおり。モックは `claude.html` の `@media (max-width: 899px), (pointer: coarse)`。

- 1 行のヘッダ（≡・会話名と project 名・Agent ピル 2 つ・⋯）。Agent の状態の行（`.status`）はなくす
- Agent ピル → Agent のシート（中断 / Compact / 設定は 44px のボタン 2 列、中断は danger）
- 会話のドロワー（左から、86%、scrim、上に「新しい会話」、下に project の選択、行 56px、⋯ 44px）
- ログは全幅。mark を見出しの行に入れる（スマホだけ。PC の `.entry` は今の 2 列のまま）。長いコードブロックは高さを抑えて「全文」とコピー、表は端の影
- 入力欄: 送り先の mark ボタン・16px の自動伸長の入力欄・画像・送信。すべて 44px 以上。作業中・質問の pill は入力欄の上
- 入力中はヘッダを隠し、`visualViewport` で `.app` の高さを合わせる
- シート: つまみ・下スワイプで閉じる・`80dvh`
- viewport から `maximum-scale=1` を外し、スマホの入力欄（質問の「その他」、役割、model の入力を含む）を 16px に
- safe-area（上下左右）

## テスト

- 純粋関数にできるもの（仮のターンの組み立て、適用待ちの解決、待ちの状態の判定など）は `src/web/client/*.test.ts` に TDD で書く
- `web-page.test.ts` には、アイコンのボタンに `aria-label` と `title` があること、`maximum-scale` が無いこと（段階 3）など、HTML の構造で確かめられるものを足す
- 見た目は Playwright で確かめる。**稼働中の Hub（127.0.0.1:4319）にはコマンドを送らない**（人が使っている）。撮るなら、テスト用の web server を別ポートで立てる（`web-server.test.ts` などの仕組みを使う）か、POST を route で止めて読むだけにする
- 各段階の RESULT に、撮ったスクリーンショット（`C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\revamp-<段階>-*.png`。PC 1440 のダーク / ライト、スマホ 390、段階 2 は待ちの状態）のパスを書く
- **モックとの一致を完了条件にする**: 各段階の RESULT の前に、実装とモックを同じ幅・テーマ・状態で撮って並べ、寸法・色と ring・アイコン・hover / 押下 / 選択中・文言の差異を直す。RESULT にはスクショのペアと、残した差異とその理由を書く
- 各段階で `pnpm test` と `pnpm typecheck` を通す。文言を足すときは `src/i18n/messages.ts` の en / ja 両方

## 範囲外

- Tauri GUI の起動待ちのウィンドウ（`gui/src-tauri`）。別のタスクにする
- model 一覧の取得中と失敗の区別（state の変更が要る）
- サーバー側で長いコマンドが `/api/input` をふさぐこと
