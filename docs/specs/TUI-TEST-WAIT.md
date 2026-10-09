# TUI-TEST-WAIT: tui.test.ts の固定待ちを条件待ちにする

## 目的

`src/tui/tui.test.ts` は、固定で 20ms 待つ `tick()` を 45 か所で使っている。並列実行の負荷で描画が 20ms に間に合わないと、実行のたびに違うテストが落ちる（flaky）。1 ファイルの実行に 8〜42 秒かかっている。

## 変更

- 描画を待つ箇所は、期待する状態になるまで待つ形にする
  - 例: `await vi.waitFor(() => expect(app.lastFrame()).toContain("待機中 · sub 2"))`
  - 待ったあとに同じ内容を `expect` し直さない
- 「表示されないこと」を確かめる箇所は、条件待ちにできない。その前に、表示されるはずの別の状態を条件待ちしてから否定を確かめる。それもできない箇所だけ固定待ちを残す
- `emit` の前の `tick()`（描画と listener の登録を待つもの）は、`connect` が呼ばれたことを待つ形にできるなら置き換える
  - `fakeClient` に「接続済み」を待てる Promise か flag を足してよい
- テストの意図（何を確かめているか）は変えない。テストの件数も減らさない

## 変更してよいファイル

- `src/tui/tui.test.ts`

## 確認

- `pnpm exec vitest run src/tui/tui.test.ts` を 3 回続けて実行し、すべて成功すること。所要時間も RESULT に書く
- `pnpm test`、`pnpm typecheck` が通ること
