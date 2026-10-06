# Agent から人への選択式の質問（`ask_user`）

設計は `docs/DESIGN.md` §12「人への質問（`ask_user`）」と §17 ログ。`chat-ux-fixes` の後に行う（画面・feed のファイルが重なるため）。

## 変更

### MCP tool（`src/mcp/server.ts`、`src/protocol/`）

- `ASK_USER_TOOL = "ask_user"` を `agent-adapter.ts` の `SEND_MESSAGE_TOOL` の隣に定数で置く
- 入力 schema（zod。`protocol/` に `askUserShape`）: `questions` 1〜4 件、各 `question`（必須）、`header?`、`options` 2〜6 件（`label` 必須、`description?`）、`multiSelect?`。上限は定数
- handler の型を `{ sendMessage, askUser }` に広げる。`askUser(from, input)` は `{ ok: true, id } | { ok: false, error }`
- 応答: `Question <id> is shown to the human. End your turn now; the answer will arrive as a new message.`。tool の description も同じ趣旨（人に判断を求めるときに使う・待たない）
- Claude の起動引数: `--allowedTools` に `mcp__clodex__ask_user` を足し、`--disallowedTools AskUserQuestion` を足す。Codex は `default_tools_approval_mode="approve"` で両方通る

- 両 Agent の指示（`src/context/role-instructions.ts`）に 1 文足す: `When you need a decision from the human, ask with the ask_user tool of the "clodex" MCP server instead of writing the question in your reply, then end your turn.`

### Coordinator（`src/coordinator/`）

- Event Bus に `{ kind: "question"; id; agent; questions; at }` と `{ kind: "answer"; id; agent; answers: string[][]; at }` を足す
- 未回答の質問を `Map<id, { agent, questions }>` で持つ。`pendingQuestions()` を公開し、`WebState` に `questions`（未回答の一覧）として入れる
- `answer(id, answers)`: 未回答でなければ拒否（理由を返す）。件数が質問数と違う・空の回答も拒否。受理したら `answer` event を出し、質問した Agent の mailbox に人間の入力として次の文章を入れる（英語。Agent 向けの文章は他の envelope と同じく英語で組み立てる）

  ```text
  Answer to your question <id>:
  - <header または question の先頭>: <回答を ", " で連結>
  ```

- 復旧（§18 `recoveryState`）に未回答の質問を含める（Hub を再起動しても答えられる）
- feed（`historyItemOf` / `parseLine` の `EVENT_KINDS`）に `question` / `answer` を通して保存する

### Shell（`src/cli/shell.ts`、`commands.ts`）

- `/answer <id> <json>`。`<json>` は `string[][]`。JSON でなければ、質問が 1 件のときに限り文字列全体を 1 つの自由記述の回答として扱う（TUI で手で打てるように）
- 引数の候補（`input-assist`）: 未回答の質問 ID（説明は最初の質問文）

### 画面（`timeline.ts`・`client-main.ts`・`web-page.ts`）

- `TimelineItem` に `{ kind: "question"; id; at; agent; questions; answers?: string[][] }`。`answer` event で同じ ID の項目に `answers` を入れる
- カード: 質問ごとに `header`（チップ）・質問文・選択肢のボタン（`description` を小さく添える。単一選択は 1 つだけ、`multiSelect` は複数）・「その他」の入力欄。全質問に回答があると「回答」ボタンが押せる。押すと `/answer <id> <json>` を送る。選択肢の label は Markdown にせず文字として出す
- 回答済みは選んだ回答を表示し、ボタンを無効にする
- 未回答があるとき、作業中パネルのボタンの隣に「質問 N」のボタン。押すと最も古い未回答のカードへスクロール（未読み込みなら `/api/history` で読み進める必要はない。カードが無ければ何もしない）
- 文言は i18n のカタログに足す（「回答」「その他」「質問」「回答済み」）
- desktop-notify: `question` event でデスクトップ通知（本文は最初の質問文）

### TUI（`tui.ts`）

- 質問をカード（Agent の色の縦線、`header`、質問文、`1. label — description` の番号つきの選択肢）として描く。回答済みは回答を出す

## テスト

- MCP: `ask_user` の受理・schema の拒否・送信元の判定
- Coordinator: 質問 → `question` event と `pendingQuestions`、回答 → `answer` event と mailbox への文章、2 度目・不明な ID・件数違いの拒否、復旧
- Shell: `/answer` の JSON・自由記述・不正な入力
- timeline: `question` / `answer` の組み立て
- Claude の起動引数に `--disallowedTools AskUserQuestion` と `ask_user` の許可が入ること
- `pnpm test`、`pnpm typecheck`。E2E は実行しない（claude が人の了承を取って実行する）
