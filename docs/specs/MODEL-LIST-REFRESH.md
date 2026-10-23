# MODEL-LIST-REFRESH: model の一覧を Agent の起動のたびに取り直す

## 背景

model の一覧（Web UI の Agent の設定のリスト、`/model` の候補）は、project を開いたときに `src/hub/project-context.ts` の `probe()`（`fetchStartupProbe`）で 1 回だけ取得している。CLI の更新などで一覧が変わっても古いまま残る。

実例（`docs/spikes/model-list.md` の 2026-10-23 の追記）: 10/22 22:28 に起動した Hub は Claude の一覧を 5 件（版の表示なし）で持ち続けていた。同じ処理で今取ると、`Fable 5.1` と `Fable 5`、`Opus 5.5`〜`Opus 4.6` など版つきの 13 件が返る。人は「Fable 5 と 5.1 のように、使える版をすべて選びたい」。

仕様の正は `docs/DESIGN.md` §28 E の「model はリストから選ぶ」の項（claude が更新済み。触らない）。

## Fixed

- Agent のプロセスを起動するたびに（Claude・Codex のどちらでも。新しい session・resume・`/new`・fresh の依頼・並列の子の会話を含む）、一覧を取り直す
  - 前の取得（成功・失敗を問わず、開始時刻）から 10 分以内なら取り直さない（定数にする）。取得中に重ねて起動しても 1 回だけ
  - 取得は待たずにバックグラウンドで行う。Agent の起動・配送を遅らせない
  - 成功したら一覧を置き換え、state を出し直す（Web UI のリストと `/model` の候補に反映される）。片方の Agent の一覧が空（その CLI の取得に失敗）なら、その Agent は前の一覧を残す
  - 同じ取得で得た利用状況は、今の起動時と同じく `applyStartupUsage` に渡してよい
  - 今の世代の判定（`generation`。sandbox の切り替えなどで古い結果を捨てる）は保つ
- 一覧は今どおり Hub で共有する（project ごとに取り直しても、最後に成功した一覧を使う。今の作りが project ごとなら、そのままでよい）
- 一覧の加工（`parseClaudeModels` / `parseCodexModels`）は変えない。Claude の古い版も含めて CLI が返したものをすべて出す

### 編集してよいファイル
- `src/hub/project-context.ts`、`src/hub/` の関連する test
- `src/agents/startup-probe.ts` とその test（取得の関数の形を変えるなら）
- Agent の起動を知るために必要な箇所（`src/coordinator/`、`src/hub/workspace.ts` など）。最小の追加だけ

## Discretion
- 起動をどこで検知するか（Agent の状態の `starting`、Adapter の起動の callback など）
- 10 分の判定の置き場所
- テストの粒度。最低限、次を確かめる
  - Agent の起動で取り直し、state の一覧が新しくなる
  - 10 分以内の 2 回目の起動では取り直さない。10 分を過ぎれば取り直す（時計は注入する）
  - 取得に失敗した Agent は前の一覧を残す

## 完了の条件
- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く
