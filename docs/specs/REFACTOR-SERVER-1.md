# REFACTOR-SERVER-1: Coordinator・Shell・main の責務を分ける（振る舞いは変えない）

独立した 3 件。**振る舞いは変えない。** 移すときに見つけたバグは直さず、RESULT の issues に書く。コミットは件ごとに分けるので、RESULT では件ごとに変更したファイルを書く。

## A. Coordinator（`src/coordinator/coordinator.ts`、596 行）

1 つのクラスが、配送・再送・自動 RESULT、配送時に添える通知、質問、復旧の記録、上限での停止、設定の中継を持っている。次をクラス（または関数の集まり）として別のファイルに切り出し、Coordinator はそれらを組み合わせる。

- `delivery-notes.ts`: 配送時に添えるもの。`humanContext`・`pendingNotices`・`holdContext` と、`deliveryNote`・`peekDeliveryNote`・`consumeDeliveryNote`・`queueHumanContext`・`previewHuman`
- `question-store.ts`: 人への質問。`questions` と、`askUser`・`answer` の中の保存・検証・回答の組み立て（mailbox への送信と Event Bus への publish は Coordinator に残してよい）
- `work-recorder.ts`: 復旧のための作業の記録。`turnWork`・`recordWork`・`recoveryWorkNote`、`recoveryState` の組み立て
- `limitHold()` は値を返す関数なのに、相手 Agent への通知（`notifyPeerLimit`）を副作用として行い、2 か所（mailbox の hold と `onEvent`）から呼ばれている。値を求める部分と通知する部分を分け、通知が今と同じ条件・回数で行われるようにする

依存の向き（Coordinator → AgentAdapter interface ← 各 Adapter）は守る。切り出したモジュールは Adapter の具体実装を import しない。

あわせて、Coordinator が `src/agents/startup-probe.ts`（プロセスを起動するモジュール）から `modelLabel` を import している。`modelLabel` と、それが使う型を、プロセスを起動しない純粋なモジュール（`src/agents/agent-adapter.ts` か新しいファイル）に移す。

## B. Shell（`src/cli/shell.ts`）の `handleLine`

- 約 270 行の switch になっている。コマンドの種類（`command.kind`）から handler を引く表にし、handler ごとに関数を分ける
- 今の会話が無いときに使えるコマンドの許可リスト（`hasCurrent` の判定）は、表の各 handler に「今の会話が要るか」を持たせ、別の一覧を持たない

## C. `src/index.ts` の `main`

- 約 270 行の 1 関数で、Hub への接続・初期化・Web・TUI・停止をまとめて持っている。`connectToHub`・`startWeb`・`installShutdown` などに分ける
- 停止の順序と時間（`STOP_TIMEOUT_MS`・`FORCE_EXIT_DELAY_MS`）、Job Object の登録が子プロセスを起動する前に行われることは変えない

## テスト

- 既存のテストがすべて通ること。テストが private のメソッドに依存していて分割で通らなくなるなら、公開の振る舞いを確かめる形に直す（確かめる内容は減らさない。直したテストを RESULT に書く）
- 切り出したモジュールには、単体のテストを足す（特に `delivery-notes`・`question-store`・`work-recorder`）
- C は、分けた関数のうち副作用の少ないもの（引数ごとの分岐など）にテストを足す

## 変更してよいファイル

- `src/coordinator/` の `coordinator.ts` と新しいモジュール、それぞれのテスト
- `src/agents/agent-adapter.ts`・`src/agents/startup-probe.ts`（`modelLabel` の移動）と、それを import しているファイルの import 文
- `src/cli/shell.ts`・`src/cli/shell.test.ts`
- `src/index.ts` と、そこから切り出す新しいファイル（`src/` の下）とそのテスト

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
