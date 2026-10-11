# CANCEL-HIDE: 取り消した入力と取り消しの知らせをログに残さない

今は送信待ちの入力を取り消しても、ログにその入力が残り、「取り消しました」の info もログに入る。取り消したものはログから消し、知らせは toast だけにする。仕様の正は `docs/DESIGN.md` §28「送信の取り消し・編集」と「上限での停止と自動再開」の `/cancel <message ID>`。

## 変更

対象のファイルは目安（`src/coordinator/coordinator.ts` の `cancelInput`、`src/cli/shell.ts` の `/cancel`、`src/web/client/timeline.ts`、feed の保存、`src/project/conversation-transcript.ts`、TUI）。同じ目的に要るファイルは確認せずに触ってよい。

1. **今の挙動を確かめる**: 人の入力が送った時点（配送前）でログ・feed・`read_conversation` の本文に入るか。入るなら何の event か。`/cancel` で出る `notice.canceled`（Coordinator）と `shell.canceled`（shell の print）が、どこに出てどこに保存されるか
2. **取り消した入力・message をログから消す**
   - 取り消したことを event（例: `input_canceled { id }`）で流し、Web UI の timeline はその ID の項目を消す。保存する feed からも除く（読み込み直しても出ない）。`read_conversation` の本文からも除く
   - 送った時点でログに出していないなら、何もしなくてよい（その旨を RESULT に書く）
   - 配送待ちの formal message の取り消しも同じ
3. **知らせを toast だけにする**
   - `notice.canceled` と `shell.canceled` をログ（Web UI のログ・保存する feed・TUI のログ）に入れず、`toast` で出す。TUI も今の toast（一時的な知らせ）の仕組みがあればそれを使う
   - 取り消せなかったとき（`shell.nothingToCancel`）は今どおり（warn）でよい
4. 文言は短く（今の文言のままでよい）

## テスト方針

- Coordinator / shell: `/cancel` で取り消したら、ログ用の notice を出さず toast を出す。取り消しの event を出す
- timeline: 取り消しの event で該当の項目が消える
- feed の保存・`read_conversation`: 取り消した入力が残らない
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、Agent が作業中の間に入力を送って取り消し、ログに残らず toast だけ出ることを確かめ、スクリーンショットの path を RESULT に書く（Agent を動かさずに送信待ちを作れるなら、それでよい）
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
