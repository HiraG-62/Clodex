# AGENT-GENERALIZE: 「相手は 1 体」の前提をなくし、Agent の一覧とメタデータ駆動にする（G1）

## 背景

3 体目の Agent `gemini`（Antigravity CLI）を足す準備。今は `AGENT_IDS = ["claude", "codex"]` を前提に、「相手は 1 体」の表（`OTHER_AGENT`・`peerOf`）、`{ claude: …, codex: … }` の手書きリテラル、`=== "claude" ? A : B` の二択が散らばっている。これを `AGENT_IDS` と registry 駆動に変える。**この段では `AGENT_IDS` に `gemini` を足さない**（挙動は今と同じまま。既存テストがそのまま通ることが安全網）。

仕様の正は `docs/DESIGN.md` §28「G — Gemini（Antigravity CLI）と N 体の Agent」（claude が更新済み。触らない）。UI（`src/web/client/`・`src/tui/`）は次の段 G2 でやるので触らない。

## Fixed

### registry（Agent ごとのメタデータ）

- `src/agents/` に registry を 1 つ置く（例: `agent-meta.ts`）。キーは `AgentId`、値は少なくとも:
  - `name`（表示名: Claude / Codex）
  - `effortLevels`（Claude: low〜max、Codex: minimal〜high の今の値）
  - `effortInMessage`（message の `effort` を受けるか。codex のみ true）
  - `usageHint`（定型文の usage hint の本文。今の CLAUDE_USAGE_NOTE / CODEX_USAGE_NOTE）
  - `cumulativeInput`（inputTotal のリセットの仕方の違い。`usage-monitor.ts:86` の `=== "claude"` をこれで置き換える）
  - `ideaPrefix`（ブレストの案 ID の接頭辞 C / X）
- 置き換える対象: `hub/notify-format.ts:24` の表示名、`coordinator/brainstorm.ts:5` の接頭辞、`protocol/messages.ts` と `coordinator.ts` の「effort は codex 宛てのみ」、`context/role-instructions.ts` の usage hint の二択
- Web クライアント（`web/client/dom.ts` の AGENTS / EFFORTS）はこの段では触らない（G2）

### 「相手は 1 体」の置き換え

- `peersOf(id): AgentId[]`（自分以外の全 Agent）を 1 か所に置き、次を置き換える:
  - `coordinator/delivery-notes.ts:7` `OTHER_AGENT`（export 先も含める）。`queueHumanContext` は宛先以外の**全員**に溜める
  - `coordinator/coordinator.ts:218` ブレストの `peers`、`:480-501` `notifyPeerLimit`（相手全員に知らせる）、`:392` `recordPeerFiles`（本人以外の全員の分を記録）
  - `context/role-instructions.ts:9` と `coordinator/usage-monitor.ts:50` の `peerOf`
  - `coordinator/brainstorm.ts:26` の逆算
- `work-baseline.ts` の peer 記録は今の「依頼元（from）」のままでよい（G1 では変えない）

### 手書きリテラルの置き換え

- `Record<AgentId, T>` の初期値は `AGENT_IDS` から組み立てるヘルパー（例: `agentRecord(init: (id: AgentId) => T)`）で作る。対象: `coordinator.ts:168-169, 296-297, 452`、`delivery-notes.ts:10-14`、`hub/project-context.ts:173-174, 229-230, 273`、`agents/model-catalog.ts:9`、`web/client/pending.ts` は G2、`hub/workspace.ts:227` の `"claude, codex"` は一覧から組み立てる
- `hub/project-context.ts:248` の `new ClaudeAdapter / new CodexAdapter` と `agents/startup-probe.ts` の claude / codex の分岐は、この段ではそのままでよい（Adapter の追加は G4）

### 設定と保存形式

- `config/config.ts` の `roles`・`rules`・`usageHints`・`threadTokenWarn` の `z.strictObject({claude, codex})` を、`AGENT_IDS` からキーを組み立てる形（全キー optional）に変える。初回のひな形（:100）も一覧から作る
- 保存形式: `project/conversation-history.ts`・`project/agent-settings.ts`・`project/recovery-store.ts` の Agent 名キーの `strictObject` も一覧から組み立てる。すべて optional にし、recovery の `queue` は無い Agent を空配列で補う。**既存のファイル（claude / codex のみ）が今までどおり読めることをテストで確かめる**
- `project/agent-settings.ts:87` `resolveStartSettings` は一覧で回す

### 定型文・文言

- `context/role-instructions.ts`: 「peer agent "X"」の 1 対 1 の文面を、自分以外の全員を並べる形にする（2 体のときの出力は今とほぼ同じ英文になること。role が無い Agent の行の扱いは今の `NOT_SPECIFIED` と同じ）。`roleLines`・`header`・solo の文言（`SOLO_REJECTED`・`delivery-notes.ts:4` の "the other agent"）は「the other agents」等の N 体で正しい言い回しにする
- `cli/shell.ts:149` の `"[Sent to both claude and codex]"` は全 Agent 名から組み立てる。`cli/commands.ts:40`・`cli/input.ts:239` の `claude|codex` の直書きは `AGENT_IDS` から作る
- ブレスト（`coordinator.ts:214-272`・`brainstorm.ts`）: 各周で「自分以外の全員の前の周の回答」を渡す。完了判定は `rounds * AGENT_IDS.length`。まとめ役の既定は今のまま。プロンプトの "the other agent's ideas" は複数形に。2 体での挙動（渡る内容・周の数）は今と同じこと

### 変えないもの

- `AGENT_IDS` の中身（2 体のまま）
- solo の型 `"free" | AgentId` と意味
- UI（`src/web/`・`src/tui/`・`gui/`）
- Budget の既定値、役割プリセット（`config/role-presets.ts`）の文面
- Adapter（`claude-adapter.ts`・`codex-adapter.ts`・`base-agent-adapter.ts`）と sandbox

## Discretion

- registry・`peersOf`・`agentRecord` の置き場所と名前
- ヘルパーを `ids: readonly AgentId[]` を引数に取る形にして、一覧をパラメータ化したユニットテストを書くか
- スキーマの組み立ての実装（`z.object(Object.fromEntries(...))` など。`any` を使わない）
- テストの粒度。最低限:
  - `peersOf` と `agentRecord` の単体
  - queueHumanContext・notifyPeerLimit・recordPeerFiles が「宛先以外の全員」に効く形になっている（2 体では従来と同一の挙動）
  - 既存の保存ファイル（claude / codex のみ・recovery の必須 queue あり）が読める
  - 定型文の 2 体での出力が従来とほぼ同じ（スナップショットの更新は意味が同じ範囲で可）
  - 既存の全テストが通る

## 完了の条件

- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧、文言を変えた定型文の before/after を書く
