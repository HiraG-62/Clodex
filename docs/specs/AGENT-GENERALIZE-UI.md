# AGENT-GENERALIZE-UI: UI の 2 体前提をなくす（G2）

## 背景

G1（AGENT-GENERALIZE、コミット 63d4c42）でサーバー側を `AGENT_IDS` と registry（`src/agents/agent-meta.ts`）駆動にした。UI（Web クライアント・TUI）には 2 体前提が残っている。この段でそれをなくす。**`AGENT_IDS` は 2 体のまま変えない**（見た目・挙動は今と同じまま。既存テストが安全網）。

仕様の正は `docs/DESIGN.md` §28「G — Gemini（Antigravity CLI）と N 体の Agent」。

## Fixed

### Web クライアント（`src/web/client/`）

- `dom.ts:14-22` の手書きの `AGENTS` / `AGENT_IDS` / `EFFORTS` をやめ、1 か所から組み立てる。クライアントは bundle に埋め込まれるので、`agent-meta.ts` から import してよい（今も `agent-adapter.js` から型を import している。実行時定数の import が bundle で問題ないことは `pnpm build` と既存の bundle テストで確かめる）
  - `EFFORTS`（Agent ごとの effort の段階）は registry の `effortLevels` から
- 送り先:
  - `web-page.ts:71-72` の Claude / Codex ボタンの直書きを、`AGENT_IDS` からの生成にする
  - `viewport.ts:8` の送り先トグル（二択）を「一覧の次の Agent へ巡回」にする
  - `compose-input.ts:6` の `^@(claude|codex|all)` を `AGENT_IDS` から組み立てる
- 色: `style.css` の `--claude` / `--codex` と `.to button[data-agent=…]`・`body[data-to=…]`・mark の色の決まりはそのまま使い、「Agent ごとの色変数 `--<id>` がある」前提に整理する（gemini の色の追加は G4。セレクタを `data-agent` 属性で汎用にできるところはする。無理に CSS を自動生成しない）
- グリッド: `.agent-strip`・`.strip-well` の `repeat(2, …)` を Agent 数から決める形にする（2 体では今と同じ見た目。`--agent-count` の CSS 変数を state から入れるなど）。スケルトン（`web-page.ts:42` の `[0,1].map`）も一覧から
- `pending.ts:15` の `["claude","codex"]`、`store.ts:20,22,33` の `"claude" | "codex"` 直書きを `AgentId` / `AGENT_IDS` に
- `input-assist.ts:127` の effort 候補の二択を registry の `effortLevels` に
- `feed-store.ts:41` は `isAgentId` 判定なら今のままでよい（確認だけ）

### TUI（`src/tui/`）

- `tui.ts:55,195,203,538` と `terminal-layout.ts:189-201,484-499` の「claude なら青、でなければ…」の二択を、Agent ごとの色表（registry か TUI 内の `Record<AgentId, …>` を `agentRecord` で組み立てる）にする

### 変えないもの

- `AGENT_IDS` の中身、見た目（2 体では今と同一）、`gui/`
- サーバー側（G1 で済み）。Adapter・sandbox（G4）

## Discretion

- クライアントへの Agent メタの渡し方（`agent-meta.ts` を直接 import するか、`dom.ts` で組み立て直すか。手書きの二重定義を残さないこと）
- CSS の整理の度合い（`data-agent` 属性化の範囲）
- テストの粒度。最低限:
  - 送り先トグルが一覧を巡回する（2 体では今と同じ往復）
  - `@` の解析が `AGENT_IDS` から組み立てられる
  - `pnpm build` で bundle が組めて、既存の bundle のテストが通る
  - 既存の全テストが通る

## 完了の条件

- `pnpm test`・`pnpm typecheck`・`pnpm lint`・`pnpm build` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く（画面の撮影は claude が行う）
