# ANTIGRAVITY-ADAPTER: gemini（Antigravity CLI）を 3 体目の Agent として足す（G4）

## 背景

G1（63d4c42）・G2（3349dd3）で 2 体前提は無くなった。agy 1.4.6 の headless は実測済み（`docs/spikes/antigravity.md`。stream-json の形・`--conversation` の再開・`--mode`・`permissions.allow`・MCP の stdio 中継と env の引き継ぎ）。この段で `AGENT_IDS` に `gemini` を足し、AntigravityAdapter を実装する。

仕様の正は `docs/DESIGN.md` §9「Permission」の表と「G4（AntigravityAdapter）の設計」（§28 G。claude が更新済み。触らない）。実測と食い違ったら QUESTION する。

## Fixed

### AGENT_IDS と registry

- `AGENT_IDS` を `["claude", "codex", "gemini"]` にする
- `AGENT_META.gemini`: name `Gemini`、ideaPrefix `G`、effortLevels `["low","medium","high","xhigh","max"]`、effortInMessage `false`、usageHint は Claude のものと同趣旨（長いコマンドは 1 回で終わるように待つ）、cumulativeInput `true`
- 既存テストの 2 体前提の期待値（定型文の列挙・設定のひな形・skeleton の数など）は 3 体に合わせて更新する。挙動の仕様は変えない

### AntigravityAdapter（`src/agents/antigravity-adapter.ts`）

- `BaseAgentAdapter` を継承し、`agy --input-format stream-json --output-format stream-json` の常駐プロセスで動かす
  - 実行ファイルの解決: PATH の `agy` が無ければ `%LOCALAPPDATA%\agy\bin\agy.exe`。どちらも無ければ `agentStartError` と同様の分かる起動エラー
  - 起動引数: permission（read-only=`--mode plan` / edit=`--mode accept-edits` / full=`--dangerously-skip-permissions`）、model（あれば `--model`）、effort（あれば `--effort`）、session があれば `--conversation <id>`
  - env: `agentEnv` を使い、`CLODEX_MCP_URL`（下記 MCP）を足す。`agent-process.ts` の子へ渡さない API キーの一覧に `GEMINI_API_KEY`・`GOOGLE_API_KEY` を足す
- event の対応:
  - `init`: `conversation_id` を `session` event に
  - `step_update` の `agent_response`: `text_delta` を連結し、step の `DONE` で `text` event（空なら出さない）
  - `step_update` の `tool`（`tool_info` あり）: `tool` event。`name` は `tool_info.name`。`run_command` は `name: "command"`・`command` に実行コマンドを入れて出す（検証の証跡が拾う形）。`write_to_file`・`replace_file_content`・`multi_replace_file_content`・`sed_file` は `files` にパスを入れる。終了コードは取れないので `tool_end` は出さない（証跡は「結果不明」になる。許容）
  - ターンごとの `result`: `turn` event（completed、本文は `response`）。`status` が `ERROR` なら failed。`denied_actions` が付いていたら `error` ではなく warn の notice（`bus` には Adapter から出せないので、`turn` の後に `error` event ではなく、`text` でなく……Adapter の既存の仕組みで人に見える形として `error` event の `warn` 相当が無ければ、`turn` の結果はそのまま、拒否の内容を stderr のログに出すだけでよい。既存の event の形を広げない）
  - `result.usage`: `usage` event（token の累積。`input_total` は cumulativeInput に合わせる）。rate_limit・context は出さない（取れない）
- 送信: `{"event":"user","message":{"content":text}}` を 1 行で書く。画像は本文にパスを書く（`[image] <path>` の 1 行。agy の stream-json は text ブロックのみ受けるため）。steer は stdin に次の user event を書けばターン後に処理される形ではない（ターン中の割り込み不可）ので、`steer` は `false` を返す（Coordinator の既存の「steer できない Agent」の扱いに任せる。既存にその扱いが無ければ QUESTION）
- 中断（`interrupt`）: プロセスを kill し、session（conversation_id）を保ったまま stopped にする。次の送信で `--conversation` 付きで起動し直す
- `applyPermission` / `setModel` / `setEffort`: 値を保存し、反映はプロセスの入れ替え（busy でなければ即入れ替え、busy なら次の起動）。Claude の quiet ターンのような仕組みは作らない
- `compact` 相当は無いので、`compact` は no-op にして notice（既存の形に合わせる。無ければ何もしない）

### MCP（send_message の経路）

- gemini の起動時に Clodex が 2 つを確かめて書く（既にあれば変えない。他のキーは保つ）:
  1. `~/.gemini/config/mcp_config.json` の `mcpServers.clodex` = `{ "command": "node", "args": ["<~/.clodex/agy-mcp-proxy.cjs の実パス>"] }`。proxy の実体は Clodex が `~/.clodex/agy-mcp-proxy.cjs` に書き出す（毎回上書きでよい）
  2. `~/.gemini/antigravity-cli/settings.json` の `permissions.allow` に `mcp(clodex/*)` を足す
- proxy: stdin の 1 行 1 JSON-RPC を、env `CLODEX_MCP_URL` の Streamable HTTP の MCP endpoint へ中継し、応答（JSON か SSE）を 1 行 1 JSON で stdout に返す。依存パッケージを使わない単体の CJS（Node 組み込みだけ）
- テスト: Clodex の実 MCP server（`startMcpServer`）を立て、proxy を子プロセスで起動して `initialize` → `tools/list` → `tools/call`（`send_message` の拒否応答でよい）が往復することを確かめる

### model の一覧・利用枠・sandbox・設定

- `startup-probe` に gemini を足す: `agy models` の出力（`slug\t表示名` の行）を `{value, label}` にする。利用枠は取得しない（gemini の usage は無しで返す）
- Web UI の利用枠ゲージ・利用状況パネルは、gemini は値が無いので今の「不明」の表示のままになること（新しい表示は作らない）
- sandbox が有効な project では gemini を起動できない: 起動しようとしたら分かる文言のエラー（i18n に追加。「sandbox では Gemini を使えません」/ "Gemini is not available in the sandbox"）。sandbox のセットアップ・authentication は gemini を対象にしない
- CLI の起動オプション `--gemini-model` を `--claude-model` / `--codex-model` と同じ形で足す
- 色: `style.css` に `--gemini`（ライト・ダーク両方。Claude / Codex と見分けられる青系）と `[data-agent="gemini"]` を足す。TUI の色表にも gemini を足す
- Web の送り先ボタン・Agent カード・TUI は G2 で一覧駆動になっているので、`gemini` を足せば出るはず。出ない箇所があれば直す

### 編集してよいファイル

- `src/agents/`（`antigravity-adapter.ts`・`agent-adapter.ts`・`agent-meta.ts`・`agent-process.ts`・`startup-probe.ts`・`model-catalog.ts` と test）
- `src/hub/project-context.ts`（Adapter の生成・MCP の設定書き・sandbox の guard）、`src/hub/` の test
- `src/cli/args.ts` と test、`src/i18n/messages.ts`
- `src/web/client/style.css`、`src/tui/` の色表
- proxy の書き出し先のコードと test（置き場所は Discretion）
- 3 体化で期待値が変わる既存の test
- `pnpm build` などの生成で書き換わるファイル

### 変えないもの

- `docs/DESIGN.md`・`docs/spikes/`、役割プリセット（G5）、Budget の既定値（G5）、ブレストの仕様（G1 で N 対応済み）
- 実 CLI を使う E2E は書いても実行しない（`CLODEX_E2E=1` の体系に載せるのは任意）

## Discretion

- Adapter 内部の実装（stream の解析の形、プロセス入れ替えの手順）
- proxy の実装の詳細（SSE の解析など）と書き出しのタイミング
- gemini の色の具体値
- テストの粒度。最低限:
  - Adapter: 偽の agy プロセス（スクリプトで stream-json を吐く）で、session・text・tool（command / files の写し）・turn・usage の対応と、kill → `--conversation` 再起動の引数
  - MCP: 上記の実 server との往復
  - probe: `agy models` の出力の解析
  - sandbox guard のエラー文言
  - 既存の全テストが 3 体で通る

## 完了の条件

- `pnpm test`・`pnpm typecheck`・`pnpm lint`・`pnpm build` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く（実 agy での動作確認と画面の撮影は claude が行う）
