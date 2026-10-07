# UI-SETTINGS（e5749c2）のレビュー指摘の修正

行番号は e5749c2 時点。修正の方法は任せる。1・2・3 はテストを先に書く。

## high

1. **project を開くたびに sandbox のセットアップ検査を await する**（`src/hub/project-context.ts:124`）
   - sandbox が off でも `ready()` が `setupStatus()` を最後まで走らせる（PowerShell の複数回起動、journal の回復、broker への接続、CLI と認証の検査）。Hub の起動と `/project` のたびに数秒止まり、sandbox を使わない人にも broker の接続が残る
   - 変更前は `/sandbox` を実行したときだけだった
   - 修正案: open では検査しない。state の `ready` は保存済みのセットアップの記録（`sandbox-setup.json` など）から軽く読むか、設定画面を開いたときに 1 回だけ非同期で取り、届いたら state を更新する

## medium

2. **`/language` の保存の失敗を捕まえていない**（`src/cli/shell.ts:368`）
   - `config.json` が壊れている・コメント付き・schema に無いキー・書き込み失敗のとき、例外がそのまま上がり、Web は 500、CLI はパスの無いエラーになる
   - 修正案: `/sandbox` と同じく try/catch で、パス付きの読める文言を print する（文言は en / ja）

## low

3. `/sandbox uninstall` の後、他の project の controller の「セットアップ済み」が古いまま残る（`src/sandbox/controller.ts:94-98`、`src/index.ts:162-171`）。uninstall の成功で全 project の状態を未セットアップにする
4. 設定画面の `.seg` が、state が 204 より先に届くと、処理の失敗後も押した値のまま残る（`client-main.ts` の `settingsChoice` の `.then`）。`ok` に関係なく `refreshOpenSheet()` する。上限の `.finally` も同じ
5. `/language` の値の判定（`src/cli/input.ts:64`）を `LANGUAGES` から引く
