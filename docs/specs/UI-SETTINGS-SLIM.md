# UI-SETTINGS-SLIM: 設定画面の部品を小さくし、上限の適用を 1 つにまとめる

前回の UI-SETTINGS-REDESIGN（commit `1cc2bf6`）の続き。節の分け方はそのままに、部品が大きくごちゃついている点を直す。仕様の正は `docs/DESIGN.md` の §14 上限（`/limits`）と §17 の「設定」のポップアップの項。

## 1. `/limits` で複数の組をまとめて変える

- `/limits <name> <n> [<name> <n> ...]` を受け付ける（`src/cli/input.ts` の `limits`）。1 つでも範囲外・不明な名前・同じ名前の重複・組になっていない値があれば、何も変えずに使い方を返す
- `ShellCommand` の `limits` は `values?: Array<{ name: LimitName; value: number }>` のように複数を持てる形にする（単一の `name` / `value` は置き換えてよい）
- shell（`src/cli/shell.ts`）は組をすべて `projectLimits.set` してから、1 行で結果を出す（例: `limits: messages 16, reviews 5`）
- 使い方の文言（`/limits [<name> <n> ...|reset|unlimited]`）と `commands.ts` の args も合わせる

## 2. 上限の「適用」を 1 つにする

- 各行の「適用」ボタンと行ごとの `form` をやめ、欄全体を 1 つの `form` にする。入力欄の `id="limit-<name>"`・`name`・`.limit-row[data-limit]`・`.limit-changed`・`.limit-default` は残す（`refreshOpenSheet` が使う）
- 下の右に「既定に戻す」「無制限」「適用」を並べる。「適用」は主の操作として見分けられる程度に（塗りの小さなボタン）
- 「適用」は、今の値（state）から変えた項目だけをまとめて `/limits <name> <n> ...` で 1 回送る。変えた項目が無いとき、または範囲外の値があるときは `disabled`
- 送っている間は入力欄と 3 つのボタンを `disabled` にし、終わったら `refreshOpenSheet()` で今の値に揃える（今の `settingsRequests` の扱いを 1 つにまとめる）
- 変えた項目を求める処理は純粋な関数に切り出す。例: `limitChanges(current: Record<LimitName, number>, draft: Record<LimitName, string>): { changes: Array<{ name; value }>; valid: boolean }`

## 3. on / off はスイッチにする

- sandbox と通知（push）の off / on の `seg` を、小さなスイッチ（`button[role="switch"][aria-checked]`）に置き換える。押すと今と逆の値を送る（sandbox は `/sandbox on|off`、通知は今の購読・解除の処理）
- 送っている間・適用待ちの表示は今の `setPending` の扱いをスイッチにも当てる
- `refreshOpenSheet` の `[data-choice="sandbox"]` / push の参照は、スイッチの `aria-checked` を更新する形に直す
- スイッチの見た目: 幅 32px・高さ 18px 前後の丸いトラックとつまみ。on は `--accent`、off は `--line-strong`。ラベル文字は付けない（名前は行の左にある）。`aria-label` に項目名

## 4. 全体を細く小さく

- 項目ごとの枠（今の `.settings-card` の中の区切りを含めた大きな余白）を詰める: 行の高さはおよそ 40〜44px、上下の padding は小さく。節の中は細い区切り線だけ
- スマホでも左に名前・右に操作の 1 行にする（前回の「名前の下に操作」はやめる）。タップ領域は操作の見た目を大きくせず、余白で 44px を確保する
- 2 択（言語・送信キー）は小さな segmented control（高さ 26〜28px・文字 12px 前後）。今の `min-width: 174px` はやめる
- 上限の数値入力は幅 56px 前後・高さ 28px 前後。4 行は「名前・数値・既定値」の列で揃える（既定値は数値の右か名前の下に小さく。どちらか見やすい方で揃える）
- シートの幅は内容に合わせて狭めてよい（目安 480px）
- 文言は足さない。節の見出し「プロジェクト」「端末」「Clodex」はそのまま。「この〜」のような言い回しは使わない

## テスト方針

- ユニットテスト
  - `parseInput`: 複数の組、単一の組（今のテストは形を合わせて残す）、重複・不明な名前・範囲外・値の欠けで `invalid`
  - shell: 複数の組を `set` し、1 行で出す
  - `limitChanges`: 変えた項目だけ返す、変更なし、範囲外・空・小数で `valid: false`
- 画面: Playwright で PC（1400×900）とスマホ（390×844）× ライト / ダークのスクリーンショットを `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存し、RESULT に path を書く。確かめること: スイッチの on / off の見え方、上限の列の揃い、「適用」の disabled / enabled、横のはみ出しがないこと
  - 起動方法は前回と同じ（`pnpm dev` は `__name is not defined` で動かないので、tsc で一時フォルダにビルドし、`CLODEX_HOME` と別ポートで `serve`）
- 最後に `pnpm test` と `pnpm typecheck` を通す。コミットはしない
