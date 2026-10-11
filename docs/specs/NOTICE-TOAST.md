# NOTICE-TOAST: Coordinator の通知（notice）をログに入れず toast で出す

今は `notice` event（復旧・利用枠の上限での待機・受け渡しの失敗・配送待ちの破棄・利用ペースの警告・`@all` の送信など）がログの項目として残る。会話の中身ではないので、ログ・保存する feed に入れず、今の通知（toast。PC は右上、スマホは上の中央）で出す。仕様の正は `docs/DESIGN.md` §17「次の知らせは `toast` で送り、ログに入れない」の `notice` の項。

## 変更

対象のファイルは目安（`src/coordinator/event-bus.ts`・`coordinator.ts`・`usage-monitor.ts`、`src/web/web-ui.ts`・`web-feed.ts`・`feed-store.ts`、`src/web/client/timeline.ts`、TUI、`src/hub/workspace.ts`）。同じ目的に要るファイルは確認せずに触ってよい。

1. **level**: `notice` event に `level?: "warn"` を足す（無ければ info）。受け渡しの失敗（`notice.handoffFailed`）・上限での待機（`notice.limitHold`）・利用ペースの警告（usage-monitor）は warn。ほかは info。publish している箇所をすべて洗い出して決める（`grep -rn 'kind: "notice"' src`）
2. **Web UI**: `connectWebFeed` で `notice` を feed の event として流さず、`toast`（level 付き）で送る。保存する feed（`FeedStore`）にも入れない。timeline の `notice` の項目は、compact の区切り（`compactAgent`）以外は作らない。前に保存した feed にある `notice` は、読み込み直したときに出さない（timeline で無視する）
3. **TUI**: 今の toast の仕組みで出し、ログに入れない
4. **terminal**（TUI でない行ごとの表示）: 今どおり 1 行で出す
5. **他の会話・他の project の通知**（`src/hub/workspace.ts` の `notify`）: 今どおり（OS の通知・Web Push の判定は変えない）。今の会話の `notice` で OS の通知を出しているところ（`desktop-notify.ts`）も今どおり
6. `limitHold` の情報（Agent のカードの再開時刻・送信待ちの一時停止の印）は state から出ているはずなので、ログから消えても見えることを確かめる

## テスト方針

- Web UI の feed: `notice` が `toast`（warn / info）になり、feed の event と保存に入らない
- timeline: `notice` の event を無視する（compact の区切りは残る）。保存済みの `notice` も出さない
- Coordinator / usage-monitor: warn の notice に `level: "warn"` が付く
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、notice を流してログに残らず toast が出ることを確かめ、スクリーンショットの path を RESULT に書く
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
