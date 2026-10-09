# SUBAGENT-VISIBLE: 動いているサブエージェントをもっと目立たせる

SUBAGENT-STATUS（commit `d382b05`）で Agent のカードとスマホのピルに灰色の小さな印（`list-tree` のアイコンと数）を出したが、待機中の表示の横で見落としやすい。仕様の正は `docs/DESIGN.md` §28「マルチエージェント」。

## 変更

1. **印を目立たせる**（`src/web/web-page.ts` の `.subagent-badge`、`client-main.ts` の `subagentBadge`）
   - その Agent の色（`--agent` / `c-<agent>` の色。カードやピルで使っている変数に合わせる）で塗る（文字は背景に合わせて読める色）
   - 作業中の表示（`state.working` の明滅など、既存の作業中のアニメーション）と同じ調子でゆっくり明滅させる。`prefers-reduced-motion: reduce` では動かさない（既存の一括の指定で止まるならそれでよい）
   - 大きさは今のままか少しだけ大きく。カードの 1 行目の高さを変えない
2. **ログの末尾の行**（`src/web/client/timeline.ts`、`client-main.ts` の `renderItem`、`web-page.ts`）
   - 起動中の行（`withStartingTurns` が足す `kind: "starting"`）と同じ置き方で、表示だけの項目（例: `kind: "subagents"`、`{ id, agent, running }`）を足す。保存しない・`items` に戻さない（今の `starting` を外す処理と同じ扱い）
   - 条件: その Agent の `status` が `busy` でも `starting` でもなく、`subagents.length > 0`。Agent ごとに 1 行、ログの一番下（起動中の行の後）
   - 見た目: Agent の mark・名前・回る印（起動中の行の印と同じ調子）・「サブエージェント {数}」（既存の `web.agent.subagents` を使う）と、その下に説明を 1 行ずつ（空なら id）。起動中の行の見た目（`.starting-turn`）に寄せてよい
   - subagent が無くなるか、Agent が作業を始めたら消える（state の更新で描き直す）
   - 判定は純粋な関数にしてテストする（例: `withSubagentRows(items, agents)` か、`withStartingTurns` に足す）
3. 文言は足さない（`web.agent.subagents` を使う）。「この〜」の言い回しは使わない

## テスト方針

- `timeline.test.ts`（または切り出した関数のテスト）
  - 待機中で subagent があると末尾に行が足される。作業中・起動中・subagent が空なら足されない
  - 両 Agent で別々に足される。起動中の行がある Agent には subagent の行を出さない
- 見た目は Playwright で、ビルド版の Hub（`pnpm exec tsc -p tsconfig.build.json --outDir <一時フォルダ>`、`CLODEX_HOME=<空の一時フォルダ>` と別ポート）に state を差し込むか DOM を差し込んで確かめる。PC とスマホ × ライト / ダーク。スクリーンショットを `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存して RESULT に path を書く
  - 一時のビルドやスクリプトはリポジトリの外（`%TEMP%` など）に置く。`rm` は使えないので、リポジトリの中に残さない
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
