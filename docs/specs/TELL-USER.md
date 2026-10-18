# TELL-USER: 作業中の人への発言を `tell_user` でチャットに出す

## 背景

ターンの途中の発言は、作業の独り言（「〜を確認する」）と人に読んでほしいこと（見つけた問題・自分で決めたこと・危険・人の作業が要ること）が混ざる。画面（`src/web/client/timeline.ts` の `applyFeedItem`）は 2 つ目以降の発言を `steps` の `say` にして畳んだ「作業」に入れるため、後者が埋もれる。

Adapter は途中の発言と最終応答を区別しない（どちらも `text` event）。文章から種類を推測せず、Agent が人に向けた発言を MCP tool で明示する。`ask_user` の待たない版にあたる。仕様の正は `docs/DESIGN.md` §12「人への発言（`tell_user`）」と §17「画面」のログの節（`tell_user` の行）。

## Fixed

### 振る舞い

- MCP tool `tell_user`（定数 `TELL_USER_TOOL` を `src/agents/agent-adapter.ts` の `ASK_USER_TOOL` の隣に置く）
  - 入力: `{ body: string }`。Markdown。空白だけは拒否、`MAX_BODY_LENGTH`（`src/protocol/messages.ts` の既存定数）を超えたら拒否（`Rejected: ...` と `isError: true`。`ask_user` と同じ返し方）
  - すぐ返す。返す文は受理した ID と「ターンは続けてよい」旨（英語）。例: `Shown to the human as ${id}. Continue your work.`
  - tool の description（英語）: 作業中に人に読んでほしいこと（findings, decisions you made, risks, actions the human must take）を出す。途中経過の独り言には使わない。最終応答で繰り返さない
- Coordinator: `tellUser(agent, input)` で検証し、Event Bus に `{ kind: "tell", id, agent, body }` を publish。`id` は `tell_<uuid の先頭など>`（既存の質問 ID の作り方に合わせる）。復旧の状態（`notifyRecoveryChange`）は変えない（未回答のような持ち越す状態が無い）
- feed: `tell` event を Web UI の feed に流して保存する（`src/web/web-ui.ts` の絞り込みに足す）
- 会話本文（`src/project/conversation-transcript.ts`）: `ConversationEntry.kind` に `"tell"` を足し、`{ kind: "tell", from: agent, to: "human", body, id }` として保存・返す
- 通知: Web Push・desktop 通知・toast・`notifyAgent` は出さない
- Web UI（`timeline.ts`）: `tell` は formal message・質問と同じく、その Agent の作業中のターンの枠の添付にする（3 つ目の `Attachment` の種類。`turn.tells` と `attachmentOrder` の `{ kind: "tell", id }`）
  - 枠の区切り（`attachToTurn` の `split: true`）、最終応答を畳んだ「作業」の最後に移す扱い、送ったターンが無いときにログに単独の項目として並べる扱いは、質問と同じ
  - 質問の `context` のような直前の発言の移動はしない
  - `hasAttachments` に tells を含める
- Web UI の描画（`log-item.ts`）: 添付の順に、Markdown の本文として出す（長さで切らない）。カードの枠・見出しは付けず、本文と同じ見た目で枠の本文に並べる（message カードのような送信元 → 宛先の行は出さない）。単独の項目のときは、その Agent の発言として mark を付ける
  - 本文の成果物の画像のパスは、最終応答と同じくプレビューにする（最終応答の本文の描画と同じ関数を使う）。成果物の未読（`shared-unread.ts`）も最終応答と同じに数える
- TUI（`src/tui/terminal-layout.ts`）: ターンのカードの本文に、添付の順で Markdown の本文として出す。単独の項目のときは Agent の発言として出す
- 役割の定型文（`src/context/role-instructions.ts`）
  - `ASK_USER_NOTE` の次に `TELL_USER_NOTE` を置く: `While working, send anything the human should read before your turn ends (findings, decisions you made, risks, actions the human must take) with the tell_user tool of the "clodex" MCP server. Do not use it for routine progress notes. Do not repeat it in your final reply.`（tool 名・server 名は定数から組む）
  - `artifactsNote` の「in your final reply or in an ask_user question」に tell_user を足す（`in your final reply, a tell_user note or an ask_user question`）。`Paths in intermediate progress notes are not shown.` は残す
  - ブレストの行の `Do not use send_message or ask_user.` を `Do not use send_message, ask_user or tell_user.` にする
- `docs/DESIGN.md` は claude が更新済み。触らない

### 編集してよいファイル

- `src/agents/agent-adapter.ts`
- `src/mcp/server.ts`、`src/mcp/server.test.ts`
- `src/coordinator/event-bus.ts`、`src/coordinator/coordinator.ts` と、その test
- `src/protocol/` の下（`tell` の schema を置くなら `questions.ts` と同じ形の新しいファイルでよい）
- `src/web/web-ui.ts`、`src/web/web-feed.ts`、`src/web/client/` の下（timeline・log-item・log-view・store・shared-unread など、`question` を扱う箇所）と、その test
- `src/tui/` の下と、その test
- `src/project/conversation-transcript.ts` と、その test
- `src/context/role-instructions.ts` と、その test
- `CoordinatorEvent` の `kind` を網羅する `switch` があり、`tell` を足すと型エラーになる箇所（`src/logging/event-log.ts`、`src/hub/` など）。そこは `tell` を無視する（通知・terminal のログに出さない）の最小の追加だけ
- `pnpm build` などの生成で書き換わるファイル

## Discretion

- `tell` の検証を Coordinator に置くか、`questions` と同じく専用の小さな class にするか
- ID の書式（他の ID と見分けられれば何でもよい）
- テストの置き場所と粒度。最低限、次を確かめる
  - MCP: `tell_user` が受理で ID を返し、空・長すぎは `isError`
  - Coordinator: `tell` event を publish する
  - timeline: 作業中のターンに添付され枠を区切る／最終応答が畳んだ作業の最後に移る／ターンが無いと単独の項目になる
  - transcript: `tell` の項目を保存して返す
  - role-instructions: 通常は `TELL_USER_NOTE` を含み、ブレストは含まない
- CSS の細部（本文と同じ見た目なら、間隔などは任せる）

## 完了の条件

- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く
