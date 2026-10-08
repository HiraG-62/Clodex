# UI-SETTINGS-REDESIGN: 設定画面の階層と配置の整理

設定画面（`openSettings`、`src/web/client/client-main.ts`）の項目と操作はそのままに、効く範囲で節に分けて見た目の階層を整える。仕様の正は `docs/DESIGN.md` §17 の「設定」のポップアップの項。

## 節と並び

| 節 | 見出し（ja / en） | 項目 |
|---|---|---|
| プロジェクト | 「プロジェクト」/ "Project" | sandbox、上限 |
| 端末 | 「端末」/ "Device" | 送信キー（スマホでは出さない）、通知（Push を使えないときは出さない） |
| Clodex | 「Clodex」/ "Clodex" | 言語、GUI の版と更新（GUI につながっていないときは出さない） |

- 節は上の順に並べる。項目が 1 つも出ない節は見出しごと出さない（例: スマホのブラウザで Push が使えないなら「端末」は出ない）
- 今の「アプリ」（`web.settings.app`）の見出しは「Clodex」の節に置き換える。GUI の版の行は節の中の 1 項目にする
- 見出しは今の `eyebrow` と同じ調子の小さな文字。節の間は区切り線か余白で分ける

## 項目の行

- PC: 左に名前（と補足）、右に操作（`seg` の選択やボタン）。名前の列の幅は節をまたいで揃える
- 狭い画面（スマホ、`mobile` の media query）: 名前の下に操作を置く
- 補足は名前の下に小さく出す: sandbox の状態（`.sandbox-ready`）
- 上限: 4 行を「名前・数値・適用・既定値」の列で揃える（grid）。「既定に戻す」「無制限」は表の下に右寄せ
- 文言は増やさない（UI 文言の方針）。新しく足すのは節の見出し 2 つ（「プロジェクト」「端末」）だけ

## 変えないもの

- 送るコマンド、localStorage のキー、確認ダイアログ、toast
- `refreshOpenSheet` と各 updater が使う class・属性: `[data-choice="..."]`、`.limit-row`・`[data-limit]`・`#limit-<name>`・`.limit-changed`・`.limit-default`、`.limits-reset`・`.limits-unlimited`、`.sandbox-ready`、`.push-settings`、`.gui-update`・`.gui-check`・`.gui-status`・`.gui-install`・`.gui-version`
- ほかのシート（Agent の設定など）の見た目

## テスト方針

- 節の組み立ては純粋な関数に切り出してユニットテストする。例: `settingsSections({ mobile, pushSupported, guiConnected })` が節と項目のキーの並びを返す
  - 全部出る場合の並び
  - スマホでは送信キーを出さない
  - Push も送信キーも出ないとき「端末」の節ごと出さない
  - GUI につながっていないとき、「Clodex」は言語だけになる
- i18n: 足した見出しのキーが ja / en の両方にあること（既存の messages のテストの形に合わせる）
- DOM の配置そのものはユニットテストしない。代わりに Playwright で見て確かめ、スクリーンショットを `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存して RESULT に path を書く
  - PC（1400×900）と スマホ（390×844）、ライトとダーク
  - 確かめること: 節の順と見出し、名前の列の揃い、上限の列の揃い、横スクロールやはみ出しがないこと
  - 起動方法: `pnpm dev`（tsx）ではページで `__name is not defined` が出て動かない。`pnpm exec tsc -p tsconfig.build.json --outDir <一時フォルダ>` でビルドし、`CLODEX_HOME=<一時フォルダ>`（`.clodex/config.json` に `{"web":{"port":47999}}`）を付けて `node <一時フォルダ>/index.js serve` で起動する。ユーザーの `~/.clodex` と動いている Hub に触れないため
- 最後に `pnpm test` と `pnpm typecheck` を通す
