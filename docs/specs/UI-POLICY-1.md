# UI-POLICY-1: Web UI の文言を UI 方針に合わせ、i18n の漏れを直す

UI 方針（CLAUDE.md・ユーザーの指示）: 状態や設定は文言のボタンや状態の文ではなく、トグルやアイコンで表す。ラベルは体言止め。「この〜」を使わない。仕様は docs/DESIGN.md（今回更新済み）の §17 Web UI の設定画面の「sandbox」「上限」、会話の一覧、§14 の `/limits unlimited`。

コミットは A〜C、D〜E、F に分けるので、RESULT ではその単位で変更したファイルを書く。

## A. 「無制限」を文言ボタンからスイッチにする

- 現状: `src/web/client/client-main.ts` の `openSettings` で、`aria-pressed` 付きの `button.limits-unlimited` にしている（1834 行付近、更新は 2062 行付近）
- 変更: sandbox と同じ `settingsSwitch` の形のスイッチにする。on で `/limits unlimited`、off で `/limits reset` を送る。状態は `state.limitsUnlimited`
- 置き場所は上限の欄の中（今のボタンの位置か、欄の見出しの行）。「既定に戻す」と「適用」は今のまま

## B. sandbox のセットアップの状態を文からアイコンにする

- 現状: `p.sandbox-ready` に「セットアップ済み / 未セットアップ」の文を入れている（1797 行・2058 行付近）
- 変更: スイッチの行に小さなアイコン（セットアップ済み: チェック、未セットアップ: 警告など。`src/web/web-icons.ts` の既存のアイコンを使い、無ければ足す）を置き、`aria-label` と title に既存の文言（`web.settings.ready` / `web.settings.notReady`）を使う。文の行は消す

## C. 会話の一覧の「固定 · 」「 · 現在」をやめる

- 現状: 会話の一覧の補足の行（1351 行付近）に `web.conv.pinned` と `web.conv.current` の文字を足している
- 変更: ピン止めした会話は、タイトルの横に小さなピンのアイコン（`aria-label`・title に「固定」）。今の会話は既存の強調（`.current`）だけで示し、文字は足さない
- 使わなくなった `web.conv.pinned`・`web.conv.current` は `src/i18n/messages.ts` から消す
- 「すでにこの会話です」（`shell.alreadyHere`）は「表示中の会話」/ "Already open" にする

## D. i18n の漏れ

- `src/web/web-page.ts` の Agent ストリップの `aria-label="Agent"` を文言のキーにする
- `client-main.ts` の model・effort の `"default"` の表示（980〜986・1254〜1257・1689・2025 行付近）を文言のキーにする（送るコマンドの値は変えない）
- tool のステップの種類 `say` / `run` / `send`（339〜342・446 行付近）を文言のキーにする
- formal message の `status`（`done` など）と issue の `severity` をそのまま表示している箇所（472・499 行付近）を文言のキーにする。`type`（`DELEGATE` など）はプロトコルの名前なので訳さない
- 上限の行の title が英語のキー名（`label.title = name`、1801 行付近）になっているので、文言にする（無くてよいなら消す）
- `src/web/client/timeline.ts:150` の `${agent}: compacted` を文言のキーにする。timeline は純関数で i18n を import できない作りなら、表示する側で文言にする（item に種類を持たせる）
- 文言は ja / en を足す。ja はラベルなので体言止め（例: 「既定」「実行」「送信」「完了」「重大」）

## E. ゲージの短いラベルを訳文から切り出さない

- 現状: ゲージのラベル（`label.split(" · ")[0]?.split("（")[0]?.split(" (")[0]`、899〜910 行付近）と `dataset.label` を、翻訳済みの長い文字列から切り出している。訳文を変えると壊れる
- 変更: ゲージを作る側（`gaugeValues` など）が、短いラベル（と `dataset.label` に入れる ID）を別のフィールドで渡す。切り出しの処理を消す
- 見た目は変えない

## F. 画像ビューアのフォーカス

- 現状: 画像ビューア（lightbox、1490〜1510 行付近）は `aria-modal` なのに、Tab で背面へ抜け、閉じた後にフォーカスが元に戻らない。シートには trap と戻しがある（2174〜2183・1391 行付近）
- 変更: シートの trap と戻しを共通の関数にして、画像ビューアにも使う。開く前にフォーカスしていた要素を覚え、閉じたら戻す

## テスト

- 純関数にしたもの（ゲージのラベル、文言の対応など）はユニットテストを書く
- `src/web/web-page.test.ts` で、`aria-label="Agent"` の直書きが無いこと、使わなくなった文言のキーが無いこと（messages の型で担保できるならそれでよい）
- 画面の見た目は一時の Hub で確かめ、RESULT に書く（CLAUDE.md の「画面の確認」。`pnpm dev serve` で動く）。スクリーンショットは `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存し、パスを RESULT に書く（設定画面と会話の一覧）

## 変更してよいファイル

- `src/web/client/client-main.ts`、`src/web/client/*.ts` とそのテスト
- `src/web/web-page.ts`、`src/web/web-page.test.ts`、`src/web/web-icons.ts`
- `src/i18n/messages.ts`
- `src/cli/shell.ts`（`shell.alreadyHere` を使う側に変更が要るときだけ）、`src/cli/shell.test.ts`（文言の期待値の更新）

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
