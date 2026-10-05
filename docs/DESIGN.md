# Windows Native AI Development Shell — Design Document

> Claude Code × Codex  
> Small Core / Long-Term Architecture  
> Status: Initial Design / v0.1-first

## 1. このプロジェクトは何か

Windows ネイティブの既存開発環境を維持したまま、**Claude Code と Codex CLI を対等な開発エージェントとして協調させるための薄い Development Shell** を作る。

目的は巨大なマルチエージェント基盤を自作することではない。

Claude と Codex にはそれぞれ特色や得意分野がある。**それぞれの得意分野を活かした分業**（例: 設計は Claude、実装は Codex）を、観測可能かつ双方向に行えるようにすることが目的である。どう分業させるかはユーザーによって異なるので、Clodex は分け方を固定せず、ユーザーが決められるようにする。

Claude Code / Codex がそれぞれ持っている CLI、認証、Agent/Subagent、Skills、Hooks、MCP などのネイティブ機能は可能な限りそのまま利用し、その上に **cross-model coordination layer** だけを追加する。

```text
Human
  │
  ▼
Development Shell
  │
  ├── Claude Code
  │     └── Claude native capabilities
  │
  └── Codex CLI
        └── Codex native capabilities
```

この Shell が担当するのは主に以下。

- Agent の起動・再開・停止
- Claude ↔ Codex の双方向通信
- Task / Message routing
- 必要最小限の Context 引き渡し
- Subscription 利用量を意識した Budget 制御
- Agent / Task / Message / Process の可観測性
- 将来的な Session persistence / Worktree / TUI

---

## 2. 背景

現在は Claude Code から Codex をプラグイン経由で呼び出すことができる。

ただし、この方式には以下の不満がある。

1. Codex 側で何が起きているか見えにくい
2. Claude → Codex という主従関係になりやすい
3. Codex → Claude を含む双方向の Agent communication を扱いにくい
4. Agent ごとの Session / Task / Context 状態を把握しにくい
5. Claude / Codex の Subscription 利用上限を意識した制御を入れにくい

既存 OSS、特に `avirtual/clodex` では以下のパターンが実証されている。

- PTY subprocess による Agent CLI 管理
- 長寿命 Agent Session
- Agent messaging
- Message bus
- Context / Cost telemetry
- Session persistence
- Agent state の可視化
- 不要な Agent を即座に wake しない制御

これらの考え方は積極的に参考にする。

一方で、本プロジェクトでは **Windows ネイティブ開発を第一級の対象** とする。

WSL への全面移行は要求しない。

特に Electron、Windows native module、PowerShell、Windows path、既存 `.env`、Git 管理外ファイル等を含む現在の開発環境をそのまま利用できることを重視する。

---

# 3. Core Philosophy

## 3.1 Role-based Division

各 Agent に **ユーザーが定義した役割** を持たせ、作業は役割に沿って Agent 間で受け渡す。

```text
Human
 │
 ▼
Entry Agent（ユーザーが選ぶ）
 │
 ├── 自分の役割の作業 ──────────> 自分で行う
 │
 └── 相手の役割の作業
             │
             ▼
          Delegate（formal message）
```

- 役割は自然文でユーザーが設定する（例: `claude: 設計とレビュー`、`codex: 実装`）。Clodex は特定の分け方を前提にしない（§13 Roles）
- どの作業がどの役割に当たるかは、役割を伝えられた **Agent が判断する**。Coordinator はタスクを分類しない（§3.9）
- 役割を設定しなければ、各 Agent は単独で作業し、必要なときだけ相手に依頼する

---

## 3.2 No Duplicate Work, Lazy Start

- 同じ作業を両方の Agent にやらせない。「Claude と Codex がいるから毎回両方に聞く」はしない
- Agent は必要になるまで起動しない（§12）
- trivial edit、formatting、単純な type error のような小さな作業は、役割にかかわらず受け取った Agent が行ってよい（受け渡しのコストの方が大きい）

---

## 3.3 Minimal Context

Agent 間で **会話履歴全体をコピーしない**。

悪い例:

```text
Claude の数万 token の会話
          │
          └──────── 全部 ────────> Codex
```

良い例:

```text
Claude
 │
 │ Task envelope
 ▼
Codex

Task: AUTH-142
Objective: race condition review
Commit: a82f39c
Files:
- src/auth/refresh.ts
```

必要な情報は Codex 自身が Repository から読む。

---

## 3.4 Artifact First

Agent 間の Source of Truth は会話ではなく Artifact を優先する。

優先順位のイメージ:

```text
Git commit / diff
      ↓
Source files
      ↓
Task artifact
      ↓
Architecture / ADR
      ↓
Agent message
      ↓
Conversation history
```

---

## 3.5 Context by Reference

巨大な Context を転送するのではなく参照情報を渡す。

例:

- Project root
- Task ID
- Commit hash
- File path
- Diff
- ADR path
- Issue location

```json
{
  "taskId": "AUTH-142",
  "repository": "C:\\dev\\my-app",
  "commit": "a82f39c",
  "files": [
    "src/auth/refresh.ts"
  ]
}
```

---

## 3.6 Budget First

Claude / Codex の Subscription 利用上限は **有限資源** として扱う。

分業は結果として 2 つの利用枠に負担を分散する。Clodex は両 Agent の利用状況（5 時間枠と週の枠）を見えるようにし、偏りを知らせる（§14）。ただし **送り先を自動で切り替えない**。Agent ごとに session が別なので、作業の途中で担当が変わると文脈が途切れ、品質にむらが出るためである。切り替えは人が作業の区切りで行う。

品質だけでなく、

> この Agent を今呼ぶ価値があるか

を Coordinator が判断できる設計にする。

正確な Token 使用量が CLI から取得できない場合でも、以下を proxy metric として記録する。

- Agent calls
- Delegations
- Review rounds
- Agent messages
- Message size
- Context references
- Files referenced
- Diff size
- Context pressure: LOW / MEDIUM / HIGH

---

## 3.7 Native Harness First

Claude Code や Codex の内部機能を再実装しない。

```text
Claude Code instance
  └── Claude native subagents / skills / hooks / MCP

Codex instance
  └── Codex native agent capabilities

Development Shell
  └── Cross-model coordination only
```

各 Agent を「エンジニア」、その Agent 内の Subagent を「そのエンジニアの専門家」と考える。

---

## 3.8 Observable, Not Chain-of-Thought

表示対象:

- CLI output
- Tool/action event
- Agent status
- Formal Agent message
- Task status
- File changes
- Git diff
- Process status
- Budget telemetry

表示対象にしない:

- private chain-of-thought
- 内部推論の推測

---

## 3.9 Deterministic Coordinator

Coordinator 自身を第三の AI にしない。

Coordinator は決定論的なソフトウェアとして、

- Routing
- Lifecycle
- Persistence
- Budget enforcement
- Wake / Resume
- Logging

を担当する。

役割の解釈（どの作業を誰に回すか）は Agent が行う。Coordinator は役割を各 Agent に伝えるだけで、内容を解釈しない。

---

## 3.10 Equal Agents

Claude と Codex を対等に扱う。

- Agent 間の message は双方向で、どちらからでも依頼・質問・結果返却ができる
- 人間の入力を最初に受け取る Agent（primary）はユーザーが選ぶ。設定ファイル（§13 Roles）、起動オプション `--primary`、`/primary`（§8）、メッセージ単位の `@claude` / `@codex`
- Coordinator はどちらかを特別扱いしない

---

# 4. Target Environment

第一対象:

```text
Windows 11
Node.js
TypeScript
PowerShell
Claude Code CLI
Codex CLI
Git
```

WSL は必須にしない。

既存プロジェクト:

```text
C:\dev\my-project
```

をそのまま扱えること。

Electron 開発でも、

```powershell
npm run electron:dev
```

を Windows native environment でそのまま実行できること。

---

# 5. Architecture

```text
┌───────────────────────────────────────────────────┐
│ Human / Terminal / Future TUI                     │
└───────────────────────┬───────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────┐
│ Development Shell                                 │
│                                                   │
│  Coordinator                                      │
│  ├── Input Router                                 │
│  ├── Task Manager                                 │
│  ├── Message Router                              │
│  ├── Context Resolver                            │
│  ├── Budget Manager                              │
│  ├── Process Manager                             │
│  └── Event Store                                 │
└───────────────┬───────────────────┬───────────────┘
                │                   │
                ▼                   ▼
       ┌────────────────┐  ┌────────────────┐
       │ Claude Adapter │  │ Codex Adapter  │
       └───────┬────────┘  └───────┬────────┘
               │                   │
               ▼                   ▼
       Claude Code CLI         Codex CLI
               │                   │
               └────────┬──────────┘
                        ▼
              Git / Files / Artifacts
                        │
                        ▼
               C:\dev\my-project
```

---

# 6. Project と Workspace

Project identity と Agent workspace は分離する。

通常:

```text
Project
C:\dev\my-project

Claude cwd
C:\dev\my-project

Codex cwd
C:\dev\my-project
```

並列編集が必要になった場合のみ:

```text
Project
C:\dev\my-project

Claude workspace
C:\dev\my-project

Codex workspace
C:\dev\.worktrees\my-project-codex
```

Worktree は v0.1 では自動生成しない。

---

# 7. Project Root Resolution

起動イメージ:

```powershell
PS C:\dev\my-project> clodex
```

Project root の解決順:

1. `--project <path>`
2. `git rev-parse --show-toplevel`
3. `process.cwd()`

起動オプション（v0.1）:

| option | 既定 | 内容 |
|---|---|---|
| `--project <path>` | 上記の解決順 | Project root |
| `--primary <claude\|codex>` | 設定ファイル（§13 Roles）、無ければ `claude` | 通常のテキストの送り先 |
| `--claude-model <model>` | CLI の既定 | Claude の model |
| `--codex-model <model>` | CLI の既定 | Codex の model |
| `--resume` | なし | この project の最新の会話を続ける（§18） |
| `--web` | 設定ファイルの `web` | Web UI を有効にする（§17 Web UI） |

---

# 8. Input UX

| Input | Action | v0.1 |
|---|---|---|
| 普通のテキスト | Primary Agent へ送信 | ✓ |
| `@claude ...` | Claude へ直接送信 | ✓ |
| `@codex ...` | Codex へ直接送信 | ✓ |
| `@all ...` | 両方へ送信（高コスト操作なので警告対象） | 未対応 |
| `!command` | foreground shell command | 未対応（§15） |
| `!& command` | background process | 未対応（§15） |
| `/command` | Shell internal command | ✓（下記） |
| Ctrl+C | 実行中の全 Agent のターンを interrupt。実行中が無ければ終了方法を案内 | ✓ |
| Ctrl+D / 入力の終端 | 受け付けた配送（Agent 間の連鎖を含む）が終わるのを待ってから終了 | ✓ |

- 送信はキューに積むだけで、入力はすぐ次を受け付ける（§12 の mailbox）
- 未対応の入力は、未対応である旨を表示して何もしない

Internal command（v0.1）:

| command | 内容 |
|---|---|
| `/interrupt [claude\|codex]` | 指定 Agent（省略時は全 Agent）の実行中ターンを interrupt する。キュー済みの message はそのまま配送される |
| `/status` | 各 Agent の状態と session ID。停止中は次の起動で使う session（/new 後の新規なら表示しない） |
| `/verbose` | terminal の詳細表示を切り替える（§17） |
| `/primary <claude\|codex>` | 通常のテキストの送り先を切り替える（§3.10） |
| `/resume [番号]` | 番号なしで過去の会話の一覧、番号付きでその会話に切り替える（§18） |
| `/compact [claude\|codex]` | 会話を要約してコンテキストを減らす。1 ターンとして mailbox で直列に送る。停止中の Agent には何もしない（docs/spikes/compact.md） |
| `/new [claude\|codex]` | 新しい session で始め直す。省略時は両 Agent を新しい会話として、指定時はその Agent だけを今の会話の中で始め直す（§18） |
| `/permission [claude\|codex] <read-only\|edit\|full>` | Agent（省略時は両方）の権限レベルを切り替える（§9 Permission） |
| `/help` | 入力方法の一覧 |
| `/exit` | 全 Agent を止めて終了 |

将来の候補: `/agents`, `/tasks`, `/messages`, `/budget`, `/worktree`, `/processes`

---

# 9. Agent Adapter

Claude Code / Codex 固有の process/session 制御を Adapter に閉じ込める。方式は §10 の Option C。

1 Adapter インスタンス = 1 Agent session（= 1 常駐プロセス）とする。v0.1 では各 Agent 1 session なので、操作の引数に session ID を持たせない。

```ts
type AgentId = "claude" | "codex";
type AgentStatus = "stopped" | "starting" | "idle" | "busy";

interface AgentStartOptions {
  cwd: string;
  resumeSessionId?: string; // 指定時は既存 session を継続する
  mcpUrl?: string;          // Coordinator の MCP endpoint（§12）
  model?: string;
}

interface TurnResult {
  status: "completed" | "interrupted" | "failed";
  text: string;             // Agent の最終応答
}

interface AgentAdapter {
  readonly id: AgentId;
  readonly status: AgentStatus;
  readonly sessionId: string | undefined;

  start(options: AgentStartOptions): Promise<void>;
  send(text: string): Promise<TurnResult>; // ターン完了で resolve。busy 中は拒否する
  compact(): Promise<TurnResult>;          // 手動 compact。1 ターンとして扱う
  setPermission(level: PermissionLevel): Promise<void>; // 停止中なら次の起動時に使う
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
}
```

`AgentEvent` は CLI 固有のイベントを正規化した observable event（§3.8）。

| type | 内容 |
|---|---|
| `session` | session ID の確定 |
| `text` | Agent の発言テキスト |
| `tool` | tool 呼び出し（名前と入力の要約） |
| `turn_started` | ターン開始（Agent が busy になった） |
| `turn` | ターン完了（`TurnResult`） |
| `rate_limit` | 5 時間 / 7 日の利用率（%）と reset 時刻 |
| `compacted` | compact が行われた（Claude の `compact_boundary`）。コンテキストの大きさは次のターンまで unknown にする。Codex は compact 後の `thread/tokenUsage/updated` で大きさが届くので出さない |
| `context` | 今のコンテキストの大きさ（token）と上限。Claude は最後の API 呼び出しの usage と `modelUsage[].contextWindow`、Codex は `thread/tokenUsage/updated` の `last.totalTokens` と `modelContextWindow` |
| `exit` | プロセス終了 |
| `error` | 認証違反・プロトコルエラー等 |

Spike の結果、v0.1 で使う操作（送信・interrupt・resume・MCP）は両 CLI とも対応しているため、capabilities は持たない。機能差が必要になった時点で追加する。

Adapter の必須処理:

- 子プロセスの環境変数から API key を取り除く（§10）
- 子プロセスに `CLODEX_AGENT=<claude|codex>` を設定する。ユーザーの hook や skill が「Clodex 配下の Agent か」を判定できるようにする（例: Agent 単体での委譲 plugin を Clodex 配下では無効にする）
- 認証方式がサブスクリプションでなければ、プロセスを止めて `error` を出す
- 実行中ターンへの追加送信（steer）は v0.1 では使わない。busy 中の `send` は Coordinator 側でキューに積む（§12）
- 予期しない承認要求（Codex の server request）はエラー応答し、`error` を出す。Codex は `approvalPolicy: "never"` で起動し、Coordinator の MCP tool だけ自動承認する

## Permission

`-p` / app-server で動く Agent には、その場で人が権限確認に答える手段がない。代わりに、両 Agent 共通の権限レベルを持ち、人が `/permission` で切り替える（docs/spikes/permission.md）。

| レベル | Claude（`--permission-mode` / `set_permission_mode`） | Codex（`sandbox` / `sandboxPolicy`） |
|---|---|---|
| `read-only` | `plan`（読み取りと計画のみ。ユーザー設定で許可済みの tool でも編集・実行しない） | `read-only` |
| `edit`（既定） | `acceptEdits` | `workspace-write` |
| `full` | `bypassPermissions` | `danger-full-access` |

- 既定は `edit`。設定ファイルの `permission` で変えられる（§13 Roles）
- Claude は `full` へ後から切り替えられるよう、常に `--allow-dangerously-skip-permissions` を付けて起動する（付けるだけでは bypass にならない）
- 反映: Claude は即時（`set_permission_mode`）、Codex は次のターンから（`turn/start` の `sandboxPolicy`。以降のターンにも引き継がれる）
- 停止中の Agent は、次の起動時にそのレベルで起動する
- 起動処理の途中で変更された場合は、起動が終わった時点で反映する

---

# 10. CLI Lifecycle

Phase 0 で Option A〜C を比較し、**Option C を採用した**（実測結果は `docs/spikes/`）。

| Option | 方式 | 判断 |
|---|---|---|
| A — Interactive PTY | ConPTY で TUI を起動し、キー入力と画面出力でやり取り | 不採用。ターン完了を画面から推測するしかなく、CLI の版更新で壊れやすい |
| B — Non-interactive + Resume | メッセージごとに CLI を起動し、session ID で resume | 単独では不採用。起動コストが毎ターンかかり、interrupt が kill しかない。Option C の復帰手段として使う |
| C — 構造化 stdio の長寿命プロセス | プロセスを常駐させ、stdin/stdout で JSON をやり取り | **採用** |

## Option C の構成

```text
Coordinator
    ├── Claude Adapter ── stdio NDJSON ── claude -p --input-format stream-json --output-format stream-json
    └── Codex Adapter  ── stdio JSON-RPC ── codex app-server
```

| 操作 | Claude | Codex |
|---|---|---|
| ターン送信 | stdin に `{"type":"user",...}` | `turn/start` |
| ターン完了 | `result` イベント | `turn/completed` 通知 |
| interrupt | `control_request`（subtype: interrupt） | `turn/interrupt` |
| 復帰（プロセス再起動後） | `-r <session_id>` で再起動 | `thread/resume` |
| 認証確認 | `system/init` の `apiKeySource === "none"` | `account/read` の `account.type === "chatgpt"` |
| 利用量 telemetry | `rate_limit_event` | `account/rateLimits/updated` |

## 起動時の必須処理

- 子プロセスの環境変数から `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` / `CODEX_API_KEY` を取り除く。Claude は API key があると黙ってそちらを使う（Spike E）
- 起動直後に認証方式を確認し、サブスクリプション認証でなければ Agent を停止してエラーにする

## リスク

- Codex app-server は experimental、Claude の stream-json 入力の control protocol はドキュメントが薄い。CLI の版更新で変わりうるので、プロトコル依存は Adapter 内に閉じ込める
- 通常の TUI は表示されない。人が直接操作したい場合は、同じ session を `claude -r <id>` / `codex resume <id>` で開く

PTY は Agent 制御には使わない。将来の Process Manager（§15）で dev server 等を扱うときに使う。

---

# 11. Agent Communication

Raw terminal output を Agent 間通信として扱わない。

```text
Execution Output
      ≠
Agent Message
```

Formal message channel を別に持つ。

## Message Types

| type | 用途 | `replyTo` |
|---|---|---|
| `QUESTION` | 相手 Agent への質問 | 任意 |
| `REVIEW_REQUEST` | レビュー依頼 | 任意 |
| `DELEGATE` | 実装・調査の委譲 | 任意 |
| `RESULT` | 依頼への結果返却 | 必須 |
| `ISSUE` | 問題の報告 | 任意 |
| `ACK` | 受領のみの通知 | 必須 |

## Message Schema

`protocol/messages.ts` に zod schema として定義する。MCP tool `send_message` の入力 schema と同一。

Agent が指定するフィールド:

| field | 必須 | 内容 |
|---|---|---|
| `to` | ✓ | `claude` / `codex`。送信元と同じ Agent は不可 |
| `type` | ✓ | Message Types のいずれか |
| `taskId` | ✓ | Task ID |
| `body` | ✓ | 依頼内容・質問・結果の要約（自然文、最大 4,000 文字。§3.3 Minimal Context） |
| `replyTo` | RESULT / ACK で必須 | 返信元の message ID |
| `commit` | | 参照する commit hash |
| `files` | | 参照する file path（project root からの相対パス） |
| `status` | | RESULT のみ。`approved` / `changes_requested` / `done` / `failed` |
| `issues` | | RESULT / ISSUE のみ。`{ file, line?, severity, summary }` の配列。severity は `low` / `medium` / `high` / `critical` |

Coordinator が付与するフィールド（Agent の自己申告は使わない）:

| field | 内容 |
|---|---|
| `id` | message ID（`msg_` + ランダム 8 桁） |
| `from` | 送信元。MCP の URL path で決める（§12） |
| `repository` | project root（§7） |
| `createdAt` | ISO 8601 |

例:

```json
{
  "id": "msg_1a2b3c4d",
  "type": "REVIEW_REQUEST",
  "from": "claude",
  "to": "codex",
  "taskId": "AUTH-142",
  "body": "refresh token処理のrace conditionを確認",
  "repository": "C:\dev\my-app",
  "commit": "a82f39c",
  "files": ["src/auth/refresh.ts"],
  "createdAt": "2026-10-05T07:00:00.000Z"
}
```

返却:

```json
{
  "id": "msg_5e6f7a8b",
  "type": "RESULT",
  "replyTo": "msg_1a2b3c4d",
  "from": "codex",
  "to": "claude",
  "taskId": "AUTH-142",
  "body": "競合あり。修正が必要",
  "status": "changes_requested",
  "issues": [
    {
      "file": "src/auth/refresh.ts",
      "line": 142,
      "severity": "high",
      "summary": "同時refreshでtoken rotationが競合する"
    }
  ],
  "repository": "C:\dev\my-app",
  "createdAt": "2026-10-05T07:05:00.000Z"
}
```

---

# 12. MCP の位置付け

MCP は **Agent → Coordinator の formal action interface** として利用する候補。

```text
Claude
  │
  │ MCP: send_message(...)
  ▼
Coordinator
  │
  │ route / persist / wake
  ▼
Codex
```

重要:

> MCP = Wake / Resume mechanism ではない。

MCP message を受け取った後、

- 対象 Agent が起動中か
- idle か
- sleeping か
- session を resume すべきか
- 新規起動すべきか

を判断するのは Coordinator。

## Endpoint

- Coordinator は `127.0.0.1` のランダムポートで Streamable HTTP の MCP server を起動する
- URL は `http://127.0.0.1:<port>/mcp/<token>`。`<token>` は起動ごと・Agent ごとのランダム値
- 送信元（`from`）は `<token>` から決める。Agent ごとに token を分けるので、同じ PC の他プロセスや相手 Agent が送信元を偽れない
- tool は `send_message` の 1 つだけ。入力 schema は §11

## 配送ルール（v0.1）

- Agent ごとに mailbox（FIFO キュー）を持ち、人間の入力と formal message を同じキューで直列に送る。実行中のターンには割り込まない
- 宛先 Agent が stopped なら、送る前に起動する。以前の session ID があれば resume する（Lazy Start: Agent は必要になるまで起動しない。§3.2）
- `ACK` は記録のみで宛先に配送しない（ACK の往復で Agent を起こさない。§25）
- 送信元への tool 応答は受理結果（message ID）だけを返す。返信は送信元の現在のターンが終わった後、新しいターンとして届く
- 起動や送信に失敗したら Event Bus に `error` を出し、そのメッセージは破棄する（v0.1 は再送しない）
- Coordinator の停止時は、先に全 mailbox を閉じて未配送分を破棄してから Agent を止める（停止中に Agent を再起動しない）

---

# 13. Context Resolver

Agent B に渡す Context は Task envelope を基本とする。formal message（§11）から決定論的に組み立て、宛先 Agent への 1 ターン分の入力として送る。

```text
[Clodex] Message msg_1a2b3c4d from claude
Type: REVIEW_REQUEST
Task: AUTH-142
Repository: C:\dev\my-app
Commit: a82f39c
Files:
- src/auth/refresh.ts

refresh token の race condition をレビュー

Reply with the send_message tool of the "clodex" MCP server (not a shell command): to="claude", type="RESULT", taskId="AUTH-142", replyTo="msg_1a2b3c4d".
Put findings in issues (file, line, severity, summary). Do not paste large content; reference files and commits.
```

- 依頼系（`QUESTION` / `REVIEW_REQUEST` / `DELEGATE`）には返信方法を指示する
- `RESULT` / `ISSUE` には返信を求めない（返信の連鎖を作らない）
- 会話履歴は含めない。Agent B は必要に応じて Repository を読む

## Native configuration

以下を巨大な共通 prompt に結合しない。

```text
CLAUDE.md → Claude
AGENTS.md → Codex
```

将来的に共有 artifact を置く場合:

```text
.ai/
├── project.md
├── architecture.md
├── tasks/
│   └── AUTH-142.md
└── decisions/
    └── ADR-003.md
```

ただし全 Agent が常時すべて読む設計にはしない。

## Roles（v0.2）

ユーザーは設定ファイルで、各 Agent の役割と既定の primary を指定できる。

| ファイル | 用途 |
|---|---|
| `~/.clodex/config.json` | ユーザー全体の既定 |
| `<project root>/.clodex.json` | project ごとの上書き（トップレベルのキー単位で上書き） |

```json
{
  "primary": "claude",
  "permission": "edit",
  "roles": {
    "claude": "設計とレビューを担当する。実装は codex に DELEGATE する。",
    "codex": "実装を担当する。設計に迷ったら claude に QUESTION する。"
  }
}
```

- `permission` は起動時の権限レベル（§9 Permission）。両 Agent に同じレベルを使う
- 優先順位: 起動オプション > project の設定 > ユーザーの設定 > 既定値（primary: `claude`、roles: なし）
- Coordinator は Agent の起動時に、固定の定型文と役割を system prompt に追加する（Claude: `--append-system-prompt`、Codex: thread の `developerInstructions`）。定型文は「相手の Agent がいること」「自分と相手の役割」「相手の役割の作業は `send_message` で依頼すること」「権限は人が `/permission` で変えるので、拒否されたらそう伝えること」を伝える
- 役割が無い Agent には、相手の Agent がいることだけを伝える
- 役割の本文は Agent の native configuration（CLAUDE.md / AGENTS.md）と結合しない。追加の指示として渡すだけ

---

# 14. Budget Manager

Agent 同士が無限に会話しないよう hard limit を持つ。

## Chain

上限は Agent が付ける `taskId` ではなく、Coordinator が追跡する **chain** 単位で数える。`taskId` は Agent が自由に作れるため、上限の単位にすると新しい `taskId` で回避できてしまう。

- 人間の入力で始まったターン中に Agent が送った message は、新しい chain を始める
- Agent が message を処理しているターン中に送った message は、その message と同じ chain に属する
- ACK は数えない（配送もしない。§12）

## 上限（v0.1）

v0.1 は設定ファイルを持たず、`coordinator/budget-manager.ts` の定数とする。

| 上限 | 既定値 | 数え方 |
|---|---|---|
| `maxMessagesPerChain` | 4 | chain 内の message 数（ACK 以外） |
| `maxReviewRoundsPerChain` | 2 | chain 内の `REVIEW_REQUEST` 数 |
| `maxDelegationsPerChain` | 2 | chain 内の `DELEGATE` + `QUESTION` 数 |
| `maxDelegationDepth` | 2 | 依頼の入れ子の深さ（下記） |

依頼の深さ:

- 人間の入力によるターン中に送った依頼は深さ 1
- 依頼（`QUESTION` / `REVIEW_REQUEST` / `DELEGATE`）を処理中に送った依頼は、処理中の依頼の深さ + 1
- 結果（`RESULT` / `ISSUE`）を処理中に送った依頼は、処理中の message と同じ深さ（2 回目のレビュー依頼など、同じ階層での継続）
- 依頼以外の message の深さは、処理中の message と同じ（無ければ 1）

上限を超える message は受理せず、送信元へ tool エラーで理由を返し、Event Bus に `error` を出す。エラー文では「上限に達したので人間に報告する」よう Agent に促す。

v0.2 では、分業の流れ（設計 → 実装の委譲 → レビュー → 修正の委譲）が上限に当たらないよう既定値を見直し、設定ファイル（§13 Roles）の `limits` で変更できるようにする。

| 上限 | v0.2 の既定値 |
|---|---|
| `maxMessagesPerChain` | 8 |
| `maxReviewRoundsPerChain` | 3 |
| `maxDelegationsPerChain` | 4 |
| `maxDelegationDepth` | 2 |

## 利用枠の可視化と通知（v0.2）

Agent Adapter の `rate_limit` event（Claude: `rate_limit_event`、Codex: `account/rateLimits/updated`）から、Agent ごとに最新の利用状況を保持する。

- **週のペース超過** = 週の使用率 − 週の経過率（経過率は reset 時刻と週の長さ 7 日から計算）。正なら使いすぎ、負なら余裕あり
- `/status` に、各 Agent の 5 時間枠の使用率と週のペース超過、コンテキストの大きさ、現在の primary を表示する。まだ受け取っていない値は `unknown`
- コンテキストの大きさは、その Agent の session が変わったとき（`session` event、`/new`、`/resume`）に unknown に戻す
- Codex は起動時に `account/rateLimits/read` で利用状況を取得する（Claude は最初の API 呼び出しの後に届く）
- 次の条件を初めて満たしたとき、1 回だけ通知する（同じ条件では繰り返さない。reset 後は再び通知できる）

| 条件 | 既定の閾値 | 通知例 |
|---|---|---|
| 週のペース超過が閾値以上 | +15 ポイント | `[CLODEX] claude is ahead of weekly pace (+18). Consider /primary codex for the next task.` |
| 5 時間枠の使用率が閾値以上 | 90% | `[CLODEX] claude 5h usage is 92%.` |

- 閾値は設定ファイルの `usageAlert` で変更できる
- 送り先の切り替えは自動で行わない（§3.6）。人が `/primary` で切り替える

## 将来

設定ファイル化、mode（economy 等）、CLI の利用率 telemetry（`rate_limit` event）による制御、`/budget` 表示は v0.2 以降。

```text
Session Budget

Claude
  Calls           12
  Delegations      2
  5h usage        2%

Codex
  Calls            3
  Delegations      0
  5h usage         1%

Cross-Agent
  Messages         7
  Review rounds    1 / 2
```

---

# 15. Process Manager

将来的には Agent 以外の development process も管理する。

```text
> !& npm run dev

Background process #1 started
```

```text
> /processes

#1 RUNNING npm run dev
```

Electron:

```text
> !& npm run electron:dev
```

これも Windows native process として起動できる。

---

# 16. Git / Worktree Policy

### Review / consultation

同一 Project を参照。

Reviewer は原則 read-only。

### Single Agent implementation

通常の working tree を利用。

### Parallel editing

本当に必要な場合のみ Git Worktree を作る。

```text
main
 ├── Claude
 │
 └── worktree/codex
      └── Codex
```

v0.1 では以下を実装しない。

- automatic worktree creation
- automatic merge
- conflict resolution
- branch orchestration

---

# 17. Observability

最終的には以下のような TUI を想定する。

```text
┌───────────────────────────────────────────────────┐
│ Project: my-app                  main @ a82f39c   │
│ Claude ●   Codex ●              Budget: LOW      │
├───────────────────────┬───────────────────────────┤
│ Claude                │ Codex                     │
│ Implementing...       │ Reviewing...              │
├───────────────────────┴───────────────────────────┤
│ Events                                            │
│ Claude → Codex  REVIEW_REQUEST                    │
│ Codex  → Claude ISSUE                             │
├───────────────────────────────────────────────────┤
│ >                                                 │
└───────────────────────────────────────────────────┘
```

ただし **v0.1 では作らない**。

v0.1 は最低限、

```text
14:32:10 [CLAUDE] session started
14:32:13 [CLAUDE] ...
14:33:01 [MESSAGE] claude -> codex REVIEW_REQUEST
14:33:02 [CODEX] session resumed
14:34:15 [MESSAGE] codex -> claude RESULT
```

程度の observable event log でよい。

## Event Bus

Coordinator 内の observable event は in-memory の Event Bus（`coordinator/event-bus.ts`）に集約する。Event log（`logging/event-log.ts`）や将来の TUI は Bus の購読者として実装する。

| kind | 内容 |
|---|---|
| `agent` | Agent Adapter が出した `AgentEvent`（§9）と、どの Agent か |
| `message` | Coordinator が受理した formal message（§11） |
| `human` | 人間の入力と送り先 Agent |
| `notice` | Coordinator から人への通知（利用枠の偏り等。§14） |

全 event に Coordinator が `at`（ISO 8601）を付ける。購読者の例外は他の購読者と publish 元に波及させない。

## Event Log（v0.1）

`logging/event-log.ts` が Event Bus を購読し、2 つの出力を行う。

| 出力 | 形式 | 内容 |
|---|---|---|
| terminal | `HH:MM:SS [CLAUDE] ...` / `[CODEX]` / `[MESSAGE]` | 人が読む用。既定は要点だけ、`/verbose` で全 event |
| file | JSONL（1 event 1 行、Event Bus の event そのまま） | 記録用。常に全 event。`~/.clodex/logs/<project 名>-<起動時刻>.jsonl` |

terminal の表示（「誰が何をしていて、誰が誰に何を頼んだか」だけを追えるようにする）:

| event | 既定 | `/verbose` |
|---|---|---|
| ターン開始（`turn_started`） | `[CLAUDE] working...` | ✓ |
| ターン完了（`turn`） | 最終応答。interrupted / failed はその旨 | ✓ |
| formal message | `[MESSAGE] claude -> codex REVIEW_REQUEST task=... ` と本文の先頭 | ✓ |
| `error` | ✓ | ✓ |
| 通知（`notice`） | `[CLODEX] ...` | ✓ |
| 人間の入力（`human`） | ×（入力行が画面に残っているため） | ✓ |
| 途中の発言（`text`）・`tool`・`rate_limit`・`session`・`exit` | × | ✓ |

log file は project の外（ホームディレクトリ）に置き、project の working tree を汚さない。

## Web UI（v0.2）

PC で動いている `clodex` を、スマホ等のブラウザから GUI で操作・観測できるようにする。スマホの接続が切れても `clodex` は PC で動き続ける。

```text
スマホのブラウザ ──HTTPS──> tailscale serve ──> 127.0.0.1:<port>（clodex の Web サーバー）
                                                    ├── GET  /          画面（HTML 1 枚、JS / CSS は inline）
                                                    ├── GET  /events    feed の配信（Server-Sent Events）
                                                    ├── GET  /api/state 状態のスナップショット
                                                    └── POST /api/input 1 行の入力
```

### 接続と認証

- **起動**: `clodex --web` または設定ファイルの `"web": { "port": 4319 }`。既定ポートは 4319
- **待ち受け**: `127.0.0.1` だけ。外部からの接続は Tailscale の `tailscale serve`（tailnet 内の端末だけが HTTPS で入れる）に任せ、Clodex は `0.0.0.0` で待ち受けない
- **認証**: 起動をまたいで同じ token を使う（`~/.clodex/web-token`、初回に生成）。`/?token=<token>` で開くと HttpOnly cookie を設定し、以後は cookie で認証する。token が無い・違うリクエストは 401
- 依存パッケージを増やさない（`node:http` と SSE のみ。画面も外部の JS ライブラリを使わない）

### feed（`/events`）

terminal の文字列ではなく、構造化したデータを JSON で送る。

| type | 内容 |
|---|---|
| `event` | Event Bus の event（§17）。formal message には相手に渡した Task envelope の全文（`envelope`）を付ける |
| `output` | コマンドの出力（`/help` 等、Shell が表示する行） |
| `state` | 状態のスナップショット（下記）。変化があるたびに送る（短い間隔の変化はまとめる） |

- 接続時に直近 1,000 件の `event` / `output` と最新の `state` を送り、以後は新しいものを流す
- 状態のスナップショット: primary、各 Agent の状態・権限・session・利用枠・コンテキスト（`/status` と同じ内容）、会話の一覧と今の会話

### 入力

- terminal と同じ `parseInput` / Shell を通す（§8）。テキスト、`@claude` / `@codex`、全スラッシュコマンドが使える
- 画面のボタン（権限、Interrupt、Compact、New、会話の切り替え、primary）は、対応するスラッシュコマンドを送るだけにする。Web 専用の操作経路を作らない

### 画面

レイアウト:

- スマホ（1 列）: 上部に Agent ごとの状態の行 → ログ → 入力欄。状態の行をタップすると、その Agent の操作パネル（利用枠、権限、Interrupt / Compact / New）が下から開く
- PC（幅 900px 以上かつマウス操作の端末）: 左に Agent パネルと会話の一覧、右にログと入力欄

ログ:

- 人間の入力、各 Agent のターン、Agent 間の message、通知、エラー、コマンドの出力を時系列に並べる
- Agent のターンは、最終応答を本文として表示し、途中の発言と tool 呼び出しを「作業」として起きた順に並べる（既定は畳む。上部の「詳細」で一括して開閉）
- Agent の応答は簡易な Markdown（段落、見出し、箇条書き、コードブロック、インラインコード、太字）として表示する
- Agent 間の message は、送信元 → 宛先、種類、本文、関連ファイル、指摘（severity 付き）、相手に渡した全文（畳む）を表示する

使い勝手の決まり:

- **横スクロールを発生させない**。長いコマンド・JSON・全文は折り返す
- 読み返している間に新しい項目が来ても勝手にスクロールしない。一番下にいないときは「新着」ボタンを出す
- 入力: PC は Enter で送信（Shift+Enter で改行）。スマホは Enter で改行し、送信はボタン（日本語入力の確定と誤送信を防ぐ）
- 送り先は入力欄の切り替えで選ぶ（既定は primary）。`/` や `@` で始まる入力はそのまま送る
- 接続が切れている間はその旨を表示し、自動で再接続する
- テーマ: システム / ライト / ダークを切り替えられる。選択はその端末のブラウザに保存する
- 内部の思考（chain-of-thought）は表示しない（§3.8）

---

# 18. Persistence

v0.1:

```text
In-memory state
+
simple event log
```

から開始してよい。

## 会話の継続（`--resume` / `/resume`）

`clodex` を起動し直しても Agent の会話を続けられるよう、**会話**（1 回の `clodex` の起動で使った Claude と Codex の session の組）の履歴をファイルに保存する。

- 保存先: `~/.clodex/state/<project root の英数字以外を - にした名前>-<パスのハッシュ 8 桁>.json`（例: `E--dev-Clodex-1a2b3c4d.json`）。ハッシュは大文字小文字を区別しないパスから作り、`C:\a-b` と `C:\a\b` のような衝突を防ぐ
- 内容: 会話の配列。各会話は `{ id, startedAt, updatedAt, title, sessions: { claude?, codex? } }`
  - `sessions`: Agent の `session` event のたびに、その Agent の分を上書きする
  - `title`: その会話で最初の人間の入力（先頭 60 文字）
  - session も title も無い会話は保存しない。新しい順に最大 20 件残す
- 起動時は新しい会話として始める。`clodex --resume` は最新の会話を続ける（各 Agent の最初の起動で、その会話の session を resume する）
- `/resume` は過去の会話を新しい順に番号付きで表示する。`/resume <番号>` でその会話に切り替える
  - 実行中のターンがある Agent がいれば拒否する（先に `/interrupt`）
  - 両 Agent をいったん止め、次に使うときに選んだ会話の session で起動する。選んだ会話に session が無い Agent は新しい session で始める
  - 切り替え前の会話も履歴に残る
- `/new` は両 Agent を止めて新しい会話を始める（前の会話は履歴に残る）。`/new <agent>` はその Agent だけを止め、今の会話の中で新しい session にする（その Agent の前の session は、その時点で会話から外して保存する）。作業中の Agent がいれば `/resume` と同じく拒否する
- コンテキストの管理（自動 compact 等）は各 CLI に任せる（§3.7）。手動で減らしたいときは `/compact`
- Claude は system prompt を session の最初に記録して resume 後も使う（`--system-prompt-snapshot` の既定）。役割（§13）を変えた後は `/new` で始め直すと確実に反映される
- 壊れたファイルは空の履歴として扱う（起動を妨げない）
- message の未配送分、Budget の chain、利用状況は保存しない（in-memory）

将来的には SQLite。

想定テーブル:

```text
agents
sessions
tasks
messages
events
workspaces
```

必要になる性質:

- Message ID
- ACK
- Idempotency
- Retry
- Timeout
- Crash recovery
- Coordinator restart recovery

---

# 19. v0.1 Scope

v0.1 の目的は、

> Windows 上で Claude Code と Codex の双方向 communication と session continuation が成立することを証明する

こと。

## 必須

- [x] TypeScript / Node.js project
- [x] Windows native execution
- [x] Project root detection
- [x] Claude Code CLI launch
- [x] Codex CLI launch
- [x] Real-time observable output
- [x] Formal Claude → Codex message
- [x] Formal Codex → Claude message
- [x] Target Agent wake / resume
- [x] Message logging
- [x] Human interrupt
- [x] Existing subscription authentication
- [x] Minimal hard budget limits

## v0.1 では作らない

- [ ] Polished TUI
- [ ] SQLite persistence
- [ ] Automatic Worktree
- [ ] Auto merge
- [ ] AI Planner
- [ ] AI Coordinator
- [ ] Mass Agent spawning
- [ ] Web UI
- [ ] Complex scheduling

---

# 20. v0.1 Acceptance Criteria

以下がすべて成立したら v0.1 成功。

1. Windows の既存 Git project から起動できる
2. Claude Code と Codex CLI を同時に管理できる
3. 両 Agent の output を識別してリアルタイム表示できる
4. Claude が formal `REVIEW_REQUEST` を Coordinator へ送れる
5. Coordinator が Codex を start/resume できる
6. Codex へ full conversation ではなく Task envelope を渡せる
7. Codex が `RESULT` / `ISSUE` を返せる
8. Coordinator が Claude を resume して結果を渡せる
9. Codex → Claude の逆方向も成立する
10. Message が `timestamp / from / to / type / taskId` 付きで記録される
11. User が Agent を interrupt できる
12. API 従量課金へ暗黙に切り替わらず、既存 CLI subscription authentication を利用できる

---

# 21. Phase 0 — Technical Spikes

本実装より先に以下を検証する。

## Spike A — Claude Code lifecycle

確認:

- CLI launch
- interactive mode
- non-interactive mode
- session ID
- resume
- interrupt
- exit
- authentication
- MCP availability

結果:

```text
docs/spikes/claude-lifecycle.md
```

---

## Spike B — Codex lifecycle

同様に確認。

結果:

```text
docs/spikes/codex-lifecycle.md
```

---

## Spike C — Windows PTY

確認:

- ConPTY
- `node-pty`
- stdin
- stdout
- stderr
- ANSI
- resize
- Ctrl+C
- process termination
- Unicode / Japanese

結果:

```text
docs/spikes/windows-pty.md
```

---

## Spike D — MCP

確認:

```text
Agent
  ↓
MCP
  ↓
Coordinator
```

formal message/action の入口として利用可能か。

特に、

```text
MCP message received
        ↓
Coordinator
        ↓
Agent wake/resume
```

が安定するか検証する。

結果:

```text
docs/spikes/mcp.md
```

---

## Spike E — Authentication

最重要。

Claude / Codex とも既存 CLI の Subscription login を利用する。

意図せず、

```text
API key
  ↓
pay-per-token API
```

へ fallback しないことを確認する。

結果:

```text
docs/spikes/authentication.md
```

---

# 22. Recommended v0.1 Structure

```text
src/
├── index.ts
│
├── coordinator/
│   ├── coordinator.ts
│   ├── agent-mailbox.ts
│   ├── event-bus.ts
│   ├── task-manager.ts
│   └── budget-manager.ts
│
├── agents/
│   ├── agent-adapter.ts
│   ├── claude-adapter.ts
│   └── codex-adapter.ts
│
├── protocol/
│   └── messages.ts
│
├── context/
│   └── context-resolver.ts
│
├── mcp/
│   └── server.ts
│
└── logging/
    └── event-log.ts
```

依存方向:

```text
Coordinator
     │
     ▼
AgentAdapter interface
     ▲
     │
Claude / Codex adapters
```

Coordinator が Claude/Codex 固有実装へ直接依存しすぎないこと。

---

# 23. Implementation Order

Claude Code は以下の順番で進める。

```text
1. Bootstrap TypeScript project

2. Project root detection

3. Windows PTY spike（Spike C）

4. Claude Code lifecycle spike（Spike A）

5. Codex CLI lifecycle spike（Spike B）

6. Authentication spike（Spike E）

7. MCP spike（Spike D）

8. Observed capabilities を元に AgentAdapter を確定（Option C、§10）

9. In-memory event bus

10. Formal message schema

11. Claude → Codex delegation

12. Codex result → Claude resume

13. Codex → Claude delegation

14. Minimal Budget Manager

15. Event log

16. End-to-end acceptance test
```

以下には進まない。

```text
TUI
SQLite
Automatic Worktree
Auto merge
AI Planner
Web UI
```

v0.1 Acceptance Criteria を満たすまでは不要。

---

# 24. Claude Code / Codex の役割

この節は **Clodex 自身の初期開発**（Clodex 完成前、Claude Code + Codex plugin で開発していた期間）での役割分担である。Clodex を使った開発での役割は、ユーザーが設定する（§3.1、§13 Roles）。

初期開発では **Claude Code を primary implementer** とする。

Codex は independent reviewer。

Codex を利用する場面:

```text
- architecture decisions with significant uncertainty
- Codex CLI integration
- MCP protocol design
- Windows process / PTY behavior
- independent review after major implementation phases
- difficult bugs after the first investigation fails
```

利用しない場面:

```text
- trivial edits
- formatting
- simple type errors
- straightforward implementation
- questions answerable confidently from the local codebase
```

Codex review request では、

```text
Relevant files
Git diff
Commit
Objective
```

のみを優先して渡す。

Full conversation history は渡さない。

---

# 25. Agent Communication Limits

Agent 同士の runaway conversation を禁止する。

- 上限は §14（chain 単位の hard limit）
- `ACK` は配送しないので、`ACK → ACK → ACK` の往復は起きない（§12）
- 返信を求めるのは依頼系の message だけ（§13）
- message ID は Coordinator が採番するので、v0.1 では重複受信は起きない。再送（retry）を入れる v0.2 で idempotency を扱う

---

# 26. Explicit Non-Goals

以下はこのプロジェクトの目的ではない。

### Claude Code の再実装

しない。

### Codex CLI の再実装

しない。

### Agent framework の自作

必要最小限以外しない。

### 全 Agent に全 Context を同期

しない。

### AI が AI を無制限に spawn

しない。

### AI Coordinator

少なくとも初期設計では採用しない。

### WSL 前提

しない。

### Electron を Linux 版で開発することを強制

しない。

### Chain-of-thought viewer

作らない。

---

# 27. Lessons from Existing Ecosystem

`avirtual/clodex` 等から参考にするもの:

```text
Long-lived Agent sessions
PTY subprocess
Message bus
Agent messaging
Context telemetry
Cost telemetry
Session persistence
Cache-aware wake
Observable agent state
```

そのままコピーするのではなく、Windows native development に適用する。

本プロジェクト側で特に重視するもの:

```text
Windows Native
       +
Role-based Division（ユーザー定義）
       +
Equal Agents
       +
Minimal Context
       +
Artifact First
       +
Budget First
```

---

# 28. Future Roadmap

## Phase 0

Technical spike。

```text
CLI lifecycle
PTY
MCP
Authentication
```

## Phase 1 — v0.1

```text
Claude ↔ Codex
bidirectional communication
session continuation
observable logs
human intervention
```

## Phase 2

```text
SQLite
session recovery
message ACK
idempotency
budget telemetry
```

## Phase 3

```text
Task dependencies
optional Worktree
parallel editing
```

## Phase 4

```text
TUI
Process Manager
Human controls
Better observability
```

## Phase 5+

実際に使用して必要性が証明された機能だけ追加する。

---

# 29. Self-hosting / Dogfooding

v0.1 が完成するまでは:

```text
Claude Code
   │
   └── Codex Plugin
          │
          ▼
Development Shell を開発
```

v0.1 完成後:

```text
Development Shell
├── Claude
└── Codex
     │
     ▼
Development Shell 自身を開発
```

以後は実際に使用して発生した摩擦を根拠に改善する。

想像上のマルチ Agent 要件を先回りして実装しない。

---

# 30. Claude Code への最初の指示

この設計書全体は **長期的な設計思想と方向性** として理解すること。

ただし、最初の実装対象は **Phase 0 と v0.1 のみ**。

最初から完成形を作ろうとしない。

特に以下を先回りして実装しないこと。

```text
- polished TUI
- SQLite persistence
- automatic Git worktrees
- automatic merge
- AI planner
- web UI
- large multi-agent orchestration
```

まず CLI lifecycle / Windows PTY / MCP / Subscription authentication を実測する。

推測で Adapter API を作り込まず、Spike で確認した実際の Claude Code / Codex CLI capabilities を元に確定する。

また、Codex を無条件に呼び出さない。

Codex は主に、

```text
Codex integration
MCP
Windows PTY
architecture uncertainty
major review
difficult bug
```

で利用する。

このプロジェクトで最も重要なのは機能数ではない。

```text
Claude Code と Codex を
Windows ネイティブ環境で
低 Context・低無駄コストのまま
対等かつ観測可能に協調させる
```

ことを優先する。
