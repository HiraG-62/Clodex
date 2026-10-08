# PENDING-QUEUE: 配送待ちの formal message を一覧に出し、取り消せるようにする

利用枠の上限で Agent が待っている間（mailbox の hold）に積まれた項目は、リセット後にそのまま配送される。人間の入力は今も送信待ちの一覧に出て `/cancel` できるが、相手の Agent からの formal message（DELEGATE など）は見えず、取り消せない。仕様の正は `docs/DESIGN.md` §14「上限での停止と自動再開」と `/cancel` の行。

## 変更

1. **mailbox**（`src/coordinator/agent-mailbox.ts`）
   - 配送待ちの formal message を順に返す getter（例: `pendingMessages: AgentMessage[]`）を足す
   - `cancel(id)` で、`inputId` だけでなく `message.id` が一致する項目も外せるようにする（`CANCELED_RESULT` で resolve。今の流れと同じ）
2. **Coordinator**（`src/coordinator/coordinator.ts`）
   - `pendingMessages()`: 全 Agent の配送待ちの message を返す。形は `{ id, agent /* 宛先 */, from, type, taskId, text /* body */ }`
   - `cancelInput(id)`: 人間の入力に無い ID なら message も探して取り消す。notice は今の `notice.canceled` と同じ。ID 省略時は今どおり最後の人間の入力だけ
   - `status()`（`AgentState`）に `holdUntil?: string`（mailbox が hold 中なら再開時刻の ISO 8601）を足す。mailbox に再開時刻を持たせる
   - 取り消しても送信元の Agent には知らせない
3. **state**（`src/web/web-feed.ts` の `WebState`、`src/index.ts`）: `pendingMessages` を足す
4. **Web UI**（`src/web/client/client-main.ts` の `renderPending`、`src/web/web-page.ts`）
   - 送信待ちの一覧に、人間の入力と message を並べる。並びは、宛先ごとに mailbox の順を保てれば十分（人間の入力 → message の順でまとめてよい）
   - message の行: 「送信元 → 宛先」・type（小さなバッジ）・本文の 1 行目・「取り消し」（`/cancel <message ID>`）。「編集」は出さない
   - 宛先の Agent が `holdUntil` を持っていれば、その宛先の行（人間の入力も含む）に一時停止のアイコンと再開時刻（`HH:MM`。日付が違えば `M/D HH:MM`）を添え、title を「再開 <時刻>」にする。文言は足しすぎない（UI 文言の方針）
   - 一覧が空でなければ今どおり出す（message だけでも出す）
5. **CLI / TUI**
   - `/status` の送信待ちの行に message も出す（例: `送信待ち: msg_xxx claude -> codex DELEGATE: <本文の先頭>`）
   - `/cancel` の引数の候補（`src/web/client/input-assist.ts`）に message ID を足す（説明は「claude → codex DELEGATE」）
   - TUI の下の行の件数（`tui.footer` の `queued`）に message も含める
6. **復旧**（`recoveryQueue`）は今どおり。取り消した message は残らない

## i18n

- 足すのは必要最小限: 再開の title（ja「再開 {time}」/ en "Resumes {time}"）、message の行の宛先（ja「{from} → {to}」）程度。「この〜」の言い回しは使わない

## テスト方針

- `agent-mailbox.test.ts`: `pendingMessages` の順、`cancel(message.id)` で外れて `CANCELED_RESULT` になる、hold 中の再開時刻を返す
- `coordinator.test.ts`: hold 中に届いた message が `pendingMessages()` に出る、`cancelInput(<message ID>)` で外れてリセット後に配送されない、`status()` の `holdUntil`
- `shell.test.ts`: `/status` に message の行、`/cancel <message ID>`
- `input-assist.test.ts`: `/cancel` の候補に message ID
- 画面: ビルド版の Hub（`pnpm exec tsc -p tsconfig.build.json --outDir <一時フォルダ>`、`CLODEX_HOME` と別ポート。`pnpm dev` は `__name is not defined` で動かない）では hold を再現しにくいので、送信待ちの一覧の DOM を組み立てる部分を純粋な関数に切り出せるなら切り出してテストし、見た目は Playwright で一覧の要素を差し込んで確かめる。スクリーンショットを `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存して RESULT に path を書く
- 最後に `pnpm test` と `pnpm typecheck`。コミットはしない
