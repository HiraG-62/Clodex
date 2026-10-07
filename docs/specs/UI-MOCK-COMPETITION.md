# Web UI 改善: モックのコンペ

`docs/specs/UI-REVAMP-AUDIT.md` の課題に対するデザイン案を、claude と codex がそれぞれ 1 案ずつ静的なモックで出し、人が見比べて方向性を決める。採用案（または組み合わせ）を DESIGN.md に反映してから本実装に入る。

## 成果物

- `docs/mocks/ui-revamp/<agent>.html`（`claude.html` / `codex.html`）。HTML 1 枚で完結（CSS・JS・SVG は inline）。外部の読み込みは今の Web UI と同じ Google Fonts だけ可
- 本体のコード（`src/`）は触らない。Hub にもつながない。中身はダミーデータ
- スクリーンショット: `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\mock-<agent>-*.png`（Playwright で撮る）
  - `pc-1440-dark`、`pc-1440-light`、`pc-loading`（初回ロード・ボタン内スピナー等）、`pc-sheet`（Agent 設定のポップアップ）
  - `mobile-390`、`mobile-390-keyboard`（入力中。高さ 55% で再現でよい）、`mobile-390-sheet`、`mobile-390-drawer`（会話一覧の出し方）
- 案の説明: HTML の先頭のコメントか、モック内の切り替え可能な説明パネルに、狙い・主な変更点・トレードオフを 5〜10 行

## 必須の条件

- テーマは今の `:root` の CSS 変数（`src/web/web-page.ts` の STYLE 冒頭）をそのまま使う。色・フォントは変えない。ダーク / ライト両方で見られること
- 画面に出す要素は今の Web UI と同じ（ヘッダ、Agent パネル 2 つ、会話一覧、ログ、入力欄、送り先切り替え、作業中・質問のタブ、シート、トースト）。機能の追加・削除はしない（配置や出し方は変えてよい）
- ログのダミーには、人の入力、Agent のターン（方針・作業の畳み・今の作業の 1 行・最終応答）、Agent 間の message、コードブロック、表、ask_user のカードを含める
- **部品**: 送り先切り替え `.to` のデザイン言語（くぼみ + 浮き + 1px ring + 色は点だけ）を他の部品に広げる。すべての操作部品に hover / press / selected / disabled / focus-visible / loading を付け、モック上で確認できるようにする
- **アイコン**: ヘッダと操作ボタンは inline SVG のアイコンのみ（`aria-label` と `title` 必須）。Lucide 相当の線のアイコンを `<symbol>` でまとめる
- **ロード表示**: トップの不確定プログレスバー、ボタン内スピナー、skeleton（初回ロードのログ・Agent パネル）、Agent の「起動中…」の仮のターン、再接続の帯を、モック内のボタン（デモ用の切り替え）で見せる
- **スマホ**: PC の縮小ではない専用のレイアウト。タップ領域 44px 以上、safe-area、キーボード表示中のログの確保、片手操作。シートはつまみ付き
- `prefers-reduced-motion` で動きを止める
- 文言は日本語。UI 文言は体言止めで短く（CLAUDE.md の「UI 文言」）

## 審査の観点

1. ヘッダ・操作ボタンが文字なしで何か分かるか
2. 部品の質感が送り先切り替えと揃っているか
3. 待っていることが必ず分かるか
4. スマホで片手で快適に使えるか（ログの面積、親指の届く範囲）
5. 本実装のコストが妥当か（今の DOM と CSS からの距離）
