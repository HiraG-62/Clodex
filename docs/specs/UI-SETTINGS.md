# テーマのボタンと設定画面の見直し

DESIGN.md の更新分（§17「レイアウト」「画面」、§13 Language、コマンドの表の `/language`、§28 i18n）を実装する。

## 1. テーマのボタン

- PC: ヘッダのアイコントレイの「成果物」と「設定」の間に置く。スマホ: ⋯ のメニューに置く
- 押すたびに システム → ライト → ダーク。アイコンは今のテーマ（monitor / sun / moon）。`title`・`aria-label` は「テーマ: <今の値>」
- 保存は今と同じ（その端末のブラウザ）

## 2. 設定画面

送り先・作業と全文・テーマを外し、次の 3 つにする。どれも対応するスラッシュコマンドを送るだけ（Web 専用の操作経路を作らない）。

- **sandbox（この project）**: off / on の `.seg` と、今の状態の 1 行（セットアップ済みか）。選ぶと `/sandbox on|off`。応答までは処理中、トップのバー。`uninstall` は置かない
- **上限（この project）**: `messages`・`reviews`・`delegations`・`depth` の 4 行。名前は人が読める文言（例: 「1 つのやり取りの message 数」）にし、`title` に内部名。数値の入力（1〜100）と既定値の表示。既定と違う行は印を付ける。各行の適用で `/limits <name> <n>`、下に「既定に戻す」で `/limits reset`
- **言語**: 日本語 / English の `.seg`。選ぶと `/language <ja|en>`

## 3. state に足すもの（WebState）

- `sandbox: { enabled: boolean; ready: boolean }`（今の project。`/sandbox` の表示と同じ情報）
- `limits: Record<"messages" | "reviews" | "delegations" | "depth", { value: number; default: number }>`（`default` は設定ファイル、無ければ既定値。`/limits reset` で戻る値）
- `language: "ja" | "en"`

## 4. `/language`

- `/language`: 今の言語を表示。`/language <ja|en>`: 変える。それ以外は使い方
- `~/.clodex/config.json` の `language` を書き換えて保存する（他のキーは保つ。書き込みは一時ファイルから置き換え）
- 変えたら `setLanguage` し直し、Web UI の画面を新しい言語で作り直す（版が変わり、開いている画面は再読み込みする）。CLI・通知も以後その言語
- Agent への言語の 1 行（人の入力の末尾）は次の入力から新しい言語。system prompt は次の session から（作り直さない）
- コマンドの一覧（`cli/commands.ts`）・`/help`・Web UI の候補・Tab 補完に足す

## テスト

- `/language` と state の追加は shell・web-feed・config のテストを先に書く（保存で他のキーを消さないこと、不正な値、版が変わること）
- 設定画面は Playwright（fixture。稼働中の Hub 4319 は使わない）で PC 1440 とスマホ 390 のスクショ。テーマのボタンの 3 状態も
- `pnpm test` と `pnpm typecheck` を通す。文言は `src/i18n/messages.ts` の en / ja 両方
