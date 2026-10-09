# RENAME-ANY-CONVERSATION: 今の会話以外も「⋯」から名前を変えられるようにする

会話の一覧の「⋯」の名前の変更は今の会話にしか出ない（`/rename <title>` が今の会話だけを対象にするため）。番号を指定して、どの会話の名前も変えられるようにする。仕様の正は `docs/DESIGN.md` の `/rename` の行と、会話の一覧の「⋯」の項。

## 変更

1. **入力の解釈**（`src/cli/input.ts`）: `/rename #<番号> <名前>` を `{ kind: "rename", index: <番号>, title }` にする。`#` が無ければ今どおり今の会話（`{ kind: "rename", title }`）。`#<番号>` だけで名前が無い・番号が不正なら使い方（`/rename [#<number>] <title>`）を返す。名前が数字で始まる `/rename 2 日目` は今の会話の名前「2 日目」のまま
2. **会話の履歴**（`src/project/conversation-history.ts`）: ID を指定して名前を変えるメソッドを足す（例: `renameConversation(id, title)`。今の `rename` と同じく長さを切り、以後の入力で名前を上書きしない印も同じに付ける）。今の会話なら今の `rename` と同じ結果になること
3. **shell**（`src/cli/shell.ts`）: 番号があれば `/pin`・`/delete` と同じ方法（`pickConversation`）で会話を選び、その会話の名前を変える。通知は今の `shell.renamed`
4. **Web UI**（`src/web/client/client-main.ts` の `openConversationMenu`）: 名前の変更を今の会話以外にも出し、`/rename #<番号> <名前>` を送る（今の会話も同じ形でよい）。prompt の初期値はその会話の名前
5. `/rename` の引数の候補（`src/web/client/input-assist.ts`）: `#` の後に会話の番号と名前を出す（`/pin` と同じ形）。難しければ省いてよい
6. `commands.ts` の args と help の文言を `[#<number>] <title>` に合わせる

## テスト方針

- `input.test.ts`: `#2 名前`、`名前`、`2 日目`（今の会話）、`#2`（名前なし → 使い方）、`#x 名前`（不正 → 使い方）
- `conversation-history.test.ts`: ほかの会話の名前を変えられ、保存される。今の会話でも同じ
- `shell.test.ts`: `/rename #2 名前` で 2 番目の会話の名前が変わり、通知が出る
- 画面の確認は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で行い、スクリーンショットの path を RESULT に書く（「⋯」のメニューに今の会話以外でも名前の変更が出ること）
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
