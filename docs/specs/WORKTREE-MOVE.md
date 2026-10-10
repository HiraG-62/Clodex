# WORKTREE-MOVE: 既存の会話を worktree に移す

今は worktree を使うには `/new worktree` で新しい会話を始めるしかない。途中まで project で進めた会話を、そのまま worktree に移せるようにする。仕様の正は `docs/DESIGN.md` §28 D1「既存の会話を worktree に移す」と §「コマンド」の `/worktree`。実測は `docs/spikes/worktree-resume.md`（両 Agent とも、別のディレクトリで resume すれば会話が続き、作業ディレクトリも新しい方に変わる）。

## 変更

対象のファイルは目安。同じ目的のために要るファイル（`src/i18n/messages.ts`、help の一覧、入力の候補など）は確認せずに触ってよい。

1. **入力**（`src/cli/input.ts`）: `/worktree`（引数なし）を足す。help の一覧と、Web UI の入力の候補（`src/web/client/input-assist.ts`）にも出す
2. **移す処理**（`src/cli/shell.ts`、`src/hub/workspace.ts`・`src/hub/project-context.ts` の今の会話の runtime、`src/project/conversation-history.ts`）
   - 拒否する条件（理由を表示して何もしない）
     - 今の会話がすでに worktree（`workDir` がある）: 「worktree で作業中」
     - どちらかの Agent が作業中、または配送待ちがある: `/resume` と同じ拒否の文言（「先に /interrupt」）
   - `src/project/worktree.ts` で `/new worktree` と同じ名前（今の会話の短い ID）の worktree を HEAD から作る。失敗したら理由を表示する（今の `/new worktree` の失敗と同じ）
   - 会話の履歴の `workDir` と `branch` を書き換えて保存する
   - 今の会話の runtime を新しい作業場所で作り直す。起動していた Agent は今の session ID で resume する（Claude は `-r <id>`、Codex は `thread/resume` の `cwd`）。起動していない Agent は今どおり次の起動で新しい作業場所を使う。sandbox が on なら `allowWorktree` を新しい作業場所に対して呼ぶ
     - runtime を作り直すと feed・mailbox・未回答の質問・Budget などが失われるなら、作り直さずに Agent だけ再起動する形でもよい。どちらにするかは既存の構造に合わせて決め、RESULT に書く。迷えば QUESTION
   - 移したら `shell.worktree` と同じ形（worktree のパスとブランチ）で知らせ、state を送り直す（会話の一覧の worktree の印・ヘッダ・file preview の作業場所が新しい方になる）
   - `worktree.setup` があれば、`/new worktree` と同じく移した直後に実行する
   - project の未コミットの変更は持ち込まない（何もしない）
3. **Web UI**（会話のメニュー `conversationMenu`）: 今の会話で、worktree でないときだけ「worktree に移す」を出す。押すと `/worktree` を送る
4. 文言は短く。「この〜」の言い回しは使わない

## テスト方針

- `input.test.ts`: `/worktree` の解釈
- `shell.test.ts`: 移せたら履歴の `workDir`・`branch` が変わり、知らせを出し、`worktree.setup` を実行する。worktree の会話・作業中・作成の失敗では拒否して履歴を変えない
- Workspace / ProjectContext のテスト: 起動していた Agent が今の session ID と新しい `cwd` で起動し直される（fake の Adapter で）
- Web UI: 会話のメニューに、worktree でない今の会話だけ「worktree に移す」が出る
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、一時の git リポジトリを project に開いて会話のメニューから移し、会話の一覧の worktree の印を確かめ、スクリーンショットの path を RESULT に書く（Agent は起動しなくてよい。作った worktree はリポジトリの外の一時フォルダに置く）
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
