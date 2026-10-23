# SAY-IN-CHAT: Agent の発言をすべてチャットの本文に出し、作業ログのパネルと tell_user をやめる

## 背景

今のターンの枠は「方針（最初の発言を 3 行で切る）」「作業（2 つ目以降の発言と tool を畳む）」「最終応答」に分かれ、途中の発言は畳んだ「作業」と、ヘッダのボタンで開く「作業ログ」パネルにしか出ない。人は途中の発言をチャットで普通に読みたい。人に向けた発言を出す MCP tool `tell_user` も作ったが、発言がすべて出るなら要らない。人の決定（2026-10-23）: 作業ログのパネルと `tell_user` を両方やめる。

仕様の正は `docs/DESIGN.md`（claude が更新済み。触らない）: §17「画面」のログの節（Agent のターンの並び・message・質問の項）、§12（`tell_user` の節を削除）、§28 の TUI のターン、成果物の画像のプレビューの範囲。

## Fixed

### ターンの表示（Web UI と TUI）
- 枠の中を、発言（`text` event）と tool 呼び出しを起きた順に並べる
  - 発言は Markdown の本文として全文出す（長さで切らない。今の最終応答の本文と同じ描き方。画像のパスのプレビューも付ける）
  - 発言と発言の間に続いた tool 呼び出しを 1 つの「作業 N 件」（今の `details` の steps）にまとめて畳む。上部の「詳細」の一括開閉は今どおり効く。tool が無いところには出さない
  - 「方針」（`plan`・`planAt`・3 行で切る表示・開閉の保持）は無くす。最初の発言もほかの発言と同じに出す
  - 「今の作業」の行は、作業中だけ直近の tool を 1 行（発言は本文に出るので tool だけ）と経過時間
  - 最終応答（`turn` の `result.text`）は、最後の発言と同じなら二重に出さない。違えば末尾に発言として足す
- formal message・質問のカードは、今どおり送った位置で枠を区切り、カードはその位置（時系列）に出す
  - 「最終応答を畳んだ作業に移す」扱いは無くす（発言は畳まないので）
  - 質問の `context`（直前の発言をカードの上に移す）は無くす。直前の発言は時系列のまま出る
  - 自動の `RESULT` / `ANSWER`（`auto: true`）が枠に付いたら、最終応答（最後の発言）を出さない（カードの本文と二重にしない）
  - 区切った後に作業（発言・tool）も message も無いままターンが終わったら、続きの枠は出さず、最終応答は最後に固定した枠の末尾に発言として入れる
- 作業中の枠を一番下に置く・終わったら末尾に固定する扱い、差分描画（変わったところだけ更新）は今どおり
- 成果物の一覧（`artifacts.ts`）: プレビューの対象をターンのすべての発言にする（今の「方針・最終応答・tell」から広げる）

### 作業ログのパネルをやめる
- ヘッダの作業ログのボタン（作業中の数）、パネル（PC）とシート（スマホ）、`workingFeed`、関連する CSS・i18n の文言・テストを消す

### `tell_user` をやめる
- MCP tool `tell_user`、`TELL_USER_TOOL`、`McpHandlers.tellUser`、`Coordinator.tellUser`、`src/protocol/tells.ts`、Event Bus の `tell` event、feed の `EVENT_KINDS` の `tell`、timeline の `tell`（項目・`tells`・`attachmentOrder` の `tell`）、Web UI・TUI の描画、transcript の `tell`、`src/hub/project-context.ts` の配線を消す
- 役割の定型文（`src/context/role-instructions.ts`）: `TELL_USER_NOTE` を消す。ブレストの行は `Do not use send_message or ask_user.` に戻す。`artifactsNote` は `write its full path in your reply text or an ask_user question` のように、途中の発言でもプレビューになる書き方にし、`Paths in intermediate progress notes are not shown.` を消す
- 保存済みの feed・transcript に残っている `tell` の行は、読み込みで捨てる（表示しない。移行はしない）

### 編集してよいファイル
- `src/web/`（`client/` を含む。`web-page.ts`・`style.css`・`log-view.ts`・`log-item.ts`・`log-diff.ts`・`timeline.ts`・`artifacts.ts`・`store.ts` など）、`src/tui/`、`src/mcp/`、`src/coordinator/`、`src/protocol/`、`src/project/conversation-transcript.ts`、`src/hub/project-context.ts`、`src/agents/agent-adapter.ts`、`src/context/role-instructions.ts`、`src/i18n/messages.ts` と、それぞれの test
- 消すファイル（`src/protocol/tells.ts` など）は普通のファイル操作で消す（git の index は変えない）
- `pnpm build` などの生成で書き換わるファイル

## Discretion
- timeline の内部の形（steps を「発言」と「tool のまとまり」の並びにするか、描画で組み立てるか）
- 差分描画の作り方（長いターンで全体を作り直さないことは保つ）
- CSS の細部（発言の間隔は今の Markdown の段落と同じでよい）
- テストの粒度。最低限、次を確かめる
  - 発言・tool・発言・tool・最終応答（= 最後の発言）の event 列で、発言 2 つが本文に全文出て、tool が 2 つの「作業」に分かれ、最終応答が二重に出ない（Web・TUI）
  - message・質問での区切りと、その位置にカードが出ること。auto RESULT のとき最終応答を出さない
  - 作業ログのパネルが無い。`tell_user` が MCP に登録されていない。定型文に tell_user が無い
  - 保存済みの feed の `tell` の行を読んでも落ちない（捨てる）

## 完了の条件
- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えた・消したファイルの一覧を書く（画面の撮影は claude が行う）
