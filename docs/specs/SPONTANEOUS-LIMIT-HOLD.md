# SPONTANEOUS-LIMIT-HOLD: Agent が自分から始めたターンでも、上限で止まったら再開を予約する

roguelike で Claude 単体で作業中、Claude が裏の subagent の完了を受けて自分から始めたターン（spontaneous turn。`BaseAgentAdapter.beginSpontaneousTurn`）が `You've hit your session limit` で失敗した。直前の利用状況は 5 時間枠 100% だったのに、再開の予約も notice も出ず、リセット時刻を過ぎても止まったままだった。上限の判定（`Coordinator.limitHold`）は mailbox が送ったターンの失敗（`AgentMailbox` の配送）でしか呼ばれないため。

ログ: `~/.clodex/logs/roguelike-20261008-235804-2de314cb.jsonl` の 21:09:57（UTC）付近。`rate_limit` 100% → `turn_started`（入力なし）→ `turn` failed。

仕様の正は `docs/DESIGN.md` §14「上限での停止と自動再開」。

## 変更

- `AgentMailbox` に、外から hold を始める public メソッドを足す（例: `holdForLimit(hold: LimitHold): void`。中身は今の private `hold`。閉じている・すでに hold 中なら何もしない）
- `Coordinator` の `agents[id].onEvent` で、`turn` の `failed` を受けたとき、その Agent の mailbox が送っているターンでなければ（`!mailbox.activeSending`）、`this.limitHold(id)` を呼び、上限なら `mailbox.holdForLimit(hold)` する
  - mailbox が送っているターンの失敗は今どおり mailbox 側で判定する（二重に hold しない）
  - `limitHold` は notice を出すので、notice も今と同じに出る
  - 再開時は今どおり mailbox の先頭に続きの指示を積んで配送を再開する。queue が空でも続きの指示を送る（止まった作業を続けさせるため）
- 復旧の状態（hold 中の Agent を「作業中だった」に含める）は今の `holding` の扱いのままでよい

## テスト方針

- `coordinator.test.ts`（FakeAgentAdapter で spontaneous turn を起こせるなら使う。無ければ `turn_started` → `turn` failed の event を emit する手段を足す）
  - 利用状況が 100% でリセット前の枠があるとき、spontaneous turn が失敗したら notice が出て、リセット時刻（+ margin）に続きの指示が配送される
  - 利用状況が 100% 未満なら hold しない
  - mailbox が送ったターンの失敗では二重に hold しない（今のテストが通ること）
- `agent-mailbox.test.ts`: `holdForLimit` で配送が止まり、時刻に続きの指示が先頭に積まれる。閉じた mailbox・hold 中は何もしない
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
