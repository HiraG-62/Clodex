# Windows Native AI Development Shell — Design Document

> Claude Code × Codex  
> Small Core / Long-Term Architecture  
> Status: v0.3 実装済み

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
| `@claude! ...` / `@codex! ...` | その Agent の実行中のターンに指示を足す（steer）。実行中でなければ通常の送信（§28 v0.3 C） | ✓ |
| `@all ...` / `@all! ...` | 両方の Agent へ同じ本文を送る（`@all!` はそれぞれに steer）。下記 | ✓ |
| `@<path>` | project のファイルへの参照（行頭でも、Agent 名でなければ参照）。存在するファイルを本文の末尾に `Referenced files:` として添える（§28 v0.3 A） | ✓ |
| `!command` | project root で shell command を実行し、出力を表示する（下記） | ✓ |
| `!& command` | background process として起動する（§15） | ✓ |
| `!> command` / `@<agent> !> command` | `!command` と同じく実行し、終わったら結果を Agent（省略時は primary）に渡して作業させる（下記） | ✓ |
| `/command` | Shell internal command | ✓（下記） |
| Ctrl+C | 実行中の全 Agent のターンを interrupt し、実行中の `!command` を止める。どちらも無ければ終了方法を案内 | ✓ |
| Ctrl+D / 入力の終端 | 受け付けた配送（Agent 間の連鎖を含む）が終わるのを待ってから終了 | ✓ |

- 送信はキューに積むだけで、入力はすぐ次を受け付ける（§12 の mailbox）

`@all`:

- `@claude ...` と `@codex ...` を続けて入力したのと同じ。人間の入力として Agent ごとに 1 件ずつキューに積む（ID も別。`/cancel` も別々）。`@<path>` の参照と画像も両方に渡す
- 2 倍の利用枠を使う操作なので、送るたびに `notice` を出す（例: `[CLODEX] @all: claude と codex に送信`）
- 同じ作業を両方がしないよう（§3.2）、Agent に渡す本文の先頭に、両方に送られた入力であることを示す 1 行（`[Sent to both claude and codex]`）を足す
- 入力の候補（`@` の後）と強調表示では、`all` を Agent 名と同じに扱う。Web UI の送り先の切り替えには足さない
- スラッシュコマンドは 1 行で書く。2 行目以降がある入力は invalid として使い方を表示し、Agent には送らない
- コマンドの一覧は `cli/commands.ts` の 1 か所にまとめ、`/help`・Web UI の候補・CLI の Tab 補完で共有する

`!command`（docs/spikes/shell-command.md）:

- project root で PowerShell（pwsh があれば pwsh、無ければ powershell.exe）の `-NoProfile -NonInteractive -Command` として実行する。出力が文字化けしないよう、先頭で出力の文字コードを UTF-8 にする。native command の終了コードを 1 に丸めないよう、後ろに `$LASTEXITCODE` を返す 1 行を足す。command（と終了コードの 1 行）は base64 にして、UTF-8 にした後で `[scriptblock]::Create` で構文解析し dot-source する。そのまま埋め込むと、構文エラーが UTF-8 にする前に出て化けるため（docs/spikes/shell-command.md）
- `$ <command>`、出力（stdout / stderr を行ごと。ANSI escape は取り除く）、`exit <code> (<秒>s)` を terminal と Web UI に表示する
- 人間が見るためのもので、出力は Agent に送らない。Agent に見せたいときは `!>` を使う

`!> command`（結果を Agent に渡す）:

- `!command` と同じく実行して表示し、終わったら結果を人間の入力として Agent に送る。送り先は `@<agent> !> command` の Agent、省略時は primary。Web UI は送り先の切り替えで選んだ Agent を `@<agent> ` として前に付ける
- 本文は定型: コマンド・終了コード・出力の末尾（最後の 200 行、20,000 文字まで。超えたら省いたことを書く）と、「結果を確認し、必要なら対応する」の指示。人間の言語（§13 Language）で書く
- 止めた（Ctrl+C・`/interrupt`）ときは送らない。起動に失敗したときはそのエラーを結果として送る
- solo で送り先が固定されているときは、その Agent に送る（`@<agent>` の指定が違えば拒否する）
- 入力は待たない（stdin は無い）。実行中も次の入力を受け付け、複数を同時に実行できる
- Ctrl+C と `/interrupt`（Agent 指定なし）は、Agent のターンに加えて実行中の command も止める（プロセスツリーごと）。`/exit` でも止める
- Web UI からも使える。Web UI は token で保護しており、`full` 権限の Agent に頼めば同じことができるため、新しい権限は増えない

Internal command（v0.1）:

| command | 内容 |
|---|---|
| `/interrupt [claude\|codex]` | 指定 Agent（省略時は全 Agent と実行中の `!command`）の実行中ターンを interrupt する。Agent 指定時、キュー済みの message はそのまま配送される。省略時は Agent 間のやり取りも止める: 配送待ちの formal message を破棄し、処理中・破棄した message の chain を閉じる（以後その chain の `send_message` は拒否）。人間の配送待ちの入力は残す |
| `/cancel [id]` | まだ配送していない人間の入力を取り消す（省略時は最後に送ったもの）。配送済みは取り消せない（`/interrupt` を使う）。Web UI は送信待ちの一覧に「編集」「取り消し」を出す（編集は取り消して本文を入力欄に戻す） |
| `/status` | 各 Agent の状態と session ID。停止中は次の起動で使う session（/new 後の新規なら表示しない）。配送待ちの人間の入力（ID・送り先・本文） |
| `/verbose` | terminal の詳細表示を切り替える（§17） |
| `/primary <claude\|codex>` | 通常のテキストの送り先を切り替える（§3.10） |
| `/resume [番号]` | 番号なしで過去の会話の一覧、番号付きでその会話に切り替える（§18） |
| `/rename <title>` | 今の会話の名前を変える（§18） |
| `/solo [enable\|disable\|claude\|codex]` | 今の会話を solo にする・解除する（§11 Solo）。引数なしは `enable` |
| `/delete <番号>` | 過去の会話を削除する（`/resume` の番号。今の会話は削除できない。§18） |
| `/pin <番号>` | 会話のピン止めを切り替える（`/resume` の番号。§18） |
| `/compact [claude\|codex]` | 会話を要約してコンテキストを減らす。1 ターンとして mailbox で直列に送る。停止中の Agent には何もしない（docs/spikes/compact.md） |
| `/new [claude\|codex]` | 新しい session で始め直す。省略時は両 Agent を新しい会話として、指定時はその Agent だけを今の会話の中で始め直す（§18） |
| `/permission [claude\|codex] <read-only\|edit\|full>` | Agent（省略時は両方）の権限レベルを切り替える（§9 Permission） |
| `/model <claude\|codex> <model>` | Agent の model を切り替える（§9 Model / Effort） |
| `/effort [claude\|codex] <level>` | Agent（省略時は両方）の reasoning effort を切り替える（§9 Model / Effort） |
| `/limits [<name> <n>\|reset]` | Agent 間のやり取りの上限を表示・変更する（§14 上限） |
| `/sandbox [on\|off\|uninstall]` | project の外への書き込みを OS で止める sandbox の表示・切り替え（§9 Sandbox） |
| `/processes [番号]` | 番号なしで `!&` の background process の一覧、番号付きでその process の出力の末尾（§15） |
| `/kill <番号>` | background process をプロセスツリーごと止める（§15） |
| `/language [ja\|en]` | 引数なしで今の言語を表示。指定すると表示の言語（§13 Language）を変え、`~/.clodex/config.json` の `language` に保存する |
| `/help` | 入力方法の一覧 |
| `/exit` | 全 Agent を止めて終了 |

将来の候補: `/agents`, `/tasks`, `/messages`, `/worktree`

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
  instructions?: string;    // system prompt に追加する定型文と役割（§13 Roles）
}

interface TurnResult {
  status: "completed" | "interrupted" | "failed";
  text: string;             // Agent の最終応答
}

interface AgentAdapter {
  readonly id: AgentId;
  readonly status: AgentStatus;
  readonly sessionId: string | undefined;
  readonly permission: PermissionLevel;
  readonly model: string | undefined;
  readonly effort: string | undefined;

  start(options: AgentStartOptions): Promise<void>;
  send(text: string): Promise<TurnResult>; // ターン完了で resolve。自発ターン中は終わるのを待って送る。それ以外の busy 中は拒否する
  compact(): Promise<TurnResult>;          // 手動 compact。1 ターンとして扱う
  setPermission(level: PermissionLevel): Promise<void>; // 停止中なら次の起動時に使う
  setModel(model: string): Promise<TurnResult | void>;
  setEffort(level: string): Promise<TurnResult | void>;
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
| `tool` | tool 呼び出し（名前と入力の要約）。Codex のファイル編集（`fileChange` item）は `name: "fileChange"`、入力は変更したファイルのパス |
| `turn_started` | ターン開始（Agent が busy になった）。自発ターン（下記）も含む |
| `turn` | ターン完了（`TurnResult`）。自発ターンも含む |
| `rate_limit` | 5 時間 / 7 日の利用率（%）と reset 時刻。プランに無い枠は含めない（Codex は枠の長さ `windowDurationMins` で見分ける。Pro は週の枠だけ） |
| `compacted` | compact が行われた（Claude の `compact_boundary`）。コンテキストの大きさは次のターンまで unknown にする（§14）。Codex は compact 後の `thread/tokenUsage/updated` で大きさが届くので出さない |
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
- 認証違反などでプロセスを止める（abort）ときは、プロセスの終了を待ってから実行中のターンを `failed`（理由は abort の理由）で終える。終了するまで idle に戻さず、終了中のプロセスに次の入力を送らない
- プロセスの終了は stdout を読み切ってから扱う（Node の `close`。`exit` の時点では最後の行が未処理のことがある）
- プロセスを止めるときはプロセスツリーごと止める（Windows は `taskkill /T /F`。Agent が起動した shell や dev server を残さない。docs/spikes/shell-command.md）

自発ターン（Claude。docs/spikes/claude-lifecycle.md）:

- Claude は入力が無くても新しいターンを始めることがある（background で動かした subagent や task の完了通知を受けて続ける）。このターンも `turn_started` → `text` / `tool` → `turn` を出し、その間は busy にする。最終応答は通常のターンと同じく表示する
- 自発ターン中に `send` / `compact` が来たら、そのターンの完了を待ってから送る（mailbox の配送を失敗させない）
- subagent（Task / Agent tool）内部の発言と tool 呼び出し（`parent_tool_use_id` が付いたもの）は、本体の `text` / `tool` として出さない。自発ターンの開始の判定にも使わない
- Codex の subagent（`multi_agent`。既定で有効）は別の thread で動き、その通知も同じ stdout に `threadId` 付きで流れる。自分の thread でない通知は無視する（無視しないと subagent の `turn/completed` で親のターンが終わる）。親の thread の `subAgentActivity` item は `tool`（name: `subagent`）として出す（docs/spikes/steer-image-subagent.md）

## Permission

`-p` / app-server で動く Agent には、その場で人が権限確認に答える手段がない。代わりに、両 Agent 共通の権限レベルを持ち、人が `/permission` で切り替える（docs/spikes/permission.md）。

| レベル | Claude（`--permission-mode` / `set_permission_mode`） | Codex（`sandbox` / `sandboxPolicy`） |
|---|---|---|
| `read-only` | `plan`（読み取りと計画のみ。ユーザー設定で許可済みの tool でも編集・実行しない） | `read-only` |
| `edit`（既定） | `acceptEdits` | `workspace-write`（ネットワーク可） |
| `full` | `bypassPermissions` | `danger-full-access` |

- 既定は `edit`。設定ファイルの `permission` で変えられる（§13 Roles）
- Codex の `edit` はネットワークを許す（起動引数の `-c sandbox_workspace_write.network_access=true` と、`sandboxPolicy` の `networkAccess: true`）。依存関係の取得など、project の作業に要るため。Schannel を使う TLS（`curl.exe`、PowerShell 5.1 の HTTPS）は Codex の sandbox では通らない（docs/spikes/codex-project-config.md）
- Claude は `full` へ後から切り替えられるよう、常に `--allow-dangerously-skip-permissions` を付けて起動する（付けるだけでは bypass にならない）
- 反映: Claude は即時（`set_permission_mode`）、Codex は次のターンから（`turn/start` の `sandboxPolicy`。以降のターンにも引き継がれる）
- 停止中の Agent は、次の起動時にそのレベルで起動する
- 起動処理の途中で変更された場合は、起動が終わった時点で反映する
- `/permission` で切り替えた値は project ごとに保存し、次の起動でも使う（下記「Agent の設定の保存」）

## Sandbox

Agent は常にフル権限で動かし、project の外への書き込み・削除を OS で止める（docs/spikes/sandbox-hybrid.md の Spike M、docs/spikes/sandbox-deny-only.md の Spike N、docs/spikes/sandbox-product.md）。ネットワーク・プロセスの実行は止めない。読み取りは `clodex-agent` に許された範囲（人のプロファイルは読めない）。既定は off で、使う人だけが `/sandbox on` にする。

仕組み:

- Agent 専用のローカルユーザー `clodex-agent`（Users グループのみ。サインイン画面に出さない）を作り、Agent はそのユーザーで動かす
- そのユーザーの中で、さらに `Authenticated Users`（S-1-5-11）と `INTERACTIVE`（S-1-5-4）を deny-only にしたトークン（UAC の filtered token と同じ仕組み）で起動する（docs/spikes/sandbox-deny-only.md の Spike N）。システム以外のドライブは既定で `Authenticated Users` に、`C:\Users\Public` は `INTERACTIVE` に Modify が付いているが、これで効かなくなる。ドライブの ACL は変更しない
  - restricted token（restricting SID）は使わない。LSA が資格情報の取得を拒否し、Schannel の TLS（Codex の通信、PowerShell 5.1 の HTTPS）が失敗するため（docs/spikes/sandbox-schannel.md）。`WRITE_RESTRICTED` は、書き込み以外の権利（スレッドの impersonation、token の複製）が照合されず、制限のない broker に成りすませるため使わない
  - `Authenticated Users`・`INTERACTIVE` にだけ読み取りが許された場所は読めない。`E:` などのドライブとシステムのディレクトリは `Users` に読み取りが許されているので読める
- 書き込みを許すのは、project（と会話の worktree）、`~/.clodex/artifacts/<project>`、`clodex-agent` 自身のプロファイルだけ。project には `clodex-agent` の Modify（継承あり）を付ける。人が所有するディレクトリなので管理者権限は要らない。付ける時間は project の大きさに比例する（`E:\dev\Clodex` で約 15 秒）
- `C:\ProgramData`・`C:\Windows\Temp` には新規作成だけできる（既存のファイルの削除はできない）。Windows の通常のユーザーと同じ
- Agent のプロセスは、Hub が起動する **broker**（`clodex-agent` として常駐する小さなプロセス）が起動し、stdio を localhost で中継する。別ユーザーとしての起動は環境変数を引き継ぎ、コマンドラインが 1024 文字までなので、Agent を直接は起動しない。broker には、`clodex-agent` のプロファイルから組み立てた環境変数（`USERPROFILE`・`APPDATA`・Machine の PATH の前に agent 側の CLI の場所、Windows PowerShell の `PSModulePath`。`HOME` は消す）を渡す
- 人のユーザーからは `clodex-agent` のプロセスを `taskkill` できないので、Agent の停止は broker に頼む
- broker と token の helper は制限のない `clodex-agent` として動く。sandbox の中の Agent がこれらのプロセスを開いて乗っ取れないよう、起動直後に自分のプロセスとスレッドの DACL を絞る（所有者の暗黙の権利を `OWNER RIGHTS` で制限し、権利は Agent のトークンで deny-only の `Authenticated Users` にだけ与える）。Agent からの `OpenProcess`・`OpenThread`（impersonation を含む）・token の取得が拒否されることを実測で確かめた
- broker のコードと Node は `%ProgramData%\Clodex-Sandbox-<人の SID>\` に置く（人・SYSTEM・Administrators は Full Control、`clodex-agent` は RX）。ディレクトリは ACL を付けた security descriptor で作成する（作ってから ACL を付けない）。中身のハッシュが同じなら使い回す
- Agent は既存の `SpawnAgentProcess` を差し替えて起動する（Adapter は変えない）。MCP は今どおり `127.0.0.1` の Hub に届く

コマンド:

| command | 内容 |
|---|---|
| `/sandbox` | 今の状態（on / off、セットアップ済みか） |
| `/sandbox on` | この project で sandbox を使う。未セットアップならセットアップを始める。両 Agent を止めて、sandbox の中で新しい session として起動し直す |
| `/sandbox off` | この project で sandbox を使わない。project に付けた ACL を外し、両 Agent を人のユーザーで新しい session として起動し直す |
| `/sandbox uninstall` | `clodex-agent` とそのプロファイル（CLI とログイン情報）を消し、付けた ACL をすべて外す（管理者権限。UAC の確認が出る）。プロファイルが読み込み中ならエラーにし、プロセスが終わってから再実行する |

- on / off は project ごとに保存する（`.settings.json` の `sandbox`）。設定ファイルの `sandbox: true` でも既定を変えられる。優先順位は Permission と同じ
- on の間は権限を `full` に固定する（`/permission` は「sandbox 中は full 固定」と返す）。off に戻すと、保存した権限レベルに戻す
- on / off を切り替えると Agent の session は引き継げない（CLI の session はユーザーのプロファイルにあるため）。Clodex の会話の履歴はそのまま残る
- 人の `!command` は今どおり人のユーザーで動かす（sandbox の対象外）

初回のセットアップ（`/sandbox on` の初回。PC の前で行う。UAC とブラウザのログインがあるため、スマホからはできない）:

1. 管理者の処理（UAC で昇格した PowerShell）: `clodex-agent` の作成、サインイン画面に出さない設定、パスワードを人のユーザーの DPAPI で `~/.clodex/agent-credential` に保存
2. CLI のインストール（broker 経由で `clodex-agent` として）: `npm i -g @anthropic-ai/claude-code @openai/codex pnpm`（`%APPDATA%\npm` に入る）
3. ログイン: `clodex-agent` の PowerShell のウィンドウを開き、`claude` と `codex login` を人が行う。終わったら、起動時の認証の検査（§9 の startup probe）を `clodex-agent` で実行して確かめる
4. 途中で失敗・中断したら、`/sandbox` に「セットアップ未完了」と出し、次の `/sandbox on` で続きから行う（各段階は冪等）

git:

- 人が作った repository は、`clodex-agent` の git から見ると `dubious ownership` になる。`/sandbox on` のとき、`clodex-agent` の git の global 設定にだけ、その project（と worktree）の `safe.directory` を足す（off では外す）
- 人の git の設定には `safe.directory` を足さない。repository のディレクトリの所有者は人のままなので要らない。Agent が `.git` を作り直した場合は所有者が `clodex-agent` になり、人の git が拒否する。これは防御として働く
- `.git/config`・`.git/hooks`（worktree の `.git/worktrees/*` の同じもの）と `.git` ディレクトリ自体の削除には、`clodex-agent` の明示の Deny を付ける。Agent が hook・`core.fsmonitor`・`include.path`・diff / filter driver を仕込み、人の権限で動く git に実行させるのを防ぐため。Agent の commit・branch はできるが、`git config` の書き換えと `git remote add` はできない
- Hub が人の権限で実行する git（file preview・`ls-files`・worktree の作成など）には、念のため `-c core.fsmonitor=false -c core.hooksPath=<空のディレクトリ>` と `--no-ext-diff --no-textconv` を付ける
- 人が sandbox の project で、Agent の書いたスクリプト（`pnpm` の scripts など）を実行すれば、それは人の権限で動く。sandbox はこれを防がない
- `/sandbox on` のとき、人の git の global の `user.name` / `user.email` を、存在する項目だけ `clodex-agent` の global に写す（Agent が commit できるように）。off では消さない
- `clodex-agent` には git の資格情報を渡さない。push は人が行う

制約（v1 では扱わない）:

- 人の `~/.claude`（CLAUDE.md・settings・skill・MCP）と `~/.codex` の設定は `clodex-agent` には無い。必要なら人が `clodex-agent` 側に用意する
- `clodex-agent` 側の CLI の更新は、Claude は自動更新、Codex と pnpm は人が `/sandbox` の案内に従って行う
- ネットワークは止めない

## Model / Effort

人が `/model`・`/effort` で、会話の途中でも Agent の model と reasoning effort を切り替えられる。

- 既定は各 CLI のユーザー設定（`~/.claude/settings.json`、`~/.codex/config.toml`）。起動オプション `--claude-model` / `--codex-model` で起動時の model を上書きできる
- 切り替えた値は `/new`・`/resume`・プロセスの再起動後も使う。project ごとに保存し、Clodex を起動し直しても使う（下記「Agent の設定の保存」）。失敗した切り替え（Claude が受け付けなかった値）は保存しない
- 反映は次のターンから。実行中のターンには影響しない。停止中の Agent は次の起動時にその値で起動する
- `/model` は model 名を検証しない（CLI が受け付けなければ、そのターンの失敗として表示される）。model 名は Agent ごとに違うので Agent の指定を必須にする
- `/effort` の値: Claude は `low` / `medium` / `high` / `xhigh` / `max`（`claude --effort`）。Codex は `ReasoningEffort`（文字列。model ごとに対応する値が違う）。Agent を省略したときは両 Agent が受け付ける値だけを許す
- `/status` と Web UI に、各 Agent の今の model と effort を表示する。CLI の既定のままで実際の値が分からなければ `default`
- 反映の方法（docs/spikes/model-effort.md で実測）: Codex は `turn/start` の `model` / `effort`（以降のターンにも引き継がれる）。Claude は `/model <model>` / `/effort <level>` を user message として mailbox の 1 ターンで直列に送る。CLI の result 文言で成功を確認し、無効値は failed の turn として表示する

## Agent の設定の保存

人が `/permission`・`/model`・`/effort`・`/limits`・`/sandbox` で切り替えた値を project ごとに保存し、`clodex` を起動し直しても使う。

- 保存先: 会話の履歴（§18）と同じ名前の `.settings.json`（例: `~/.clodex/state/E--dev-Clodex-1a2b3c4d.settings.json`）。内容は `{ "claude": { "permission", "model", "effort" }, "codex": { ... }, "limits": { ... }, "sandbox": true }`（`limits` は `/limits` で変えた上限だけ。§14。`sandbox` は §9 Sandbox）
- 保存するのは人が切り替えた値だけ。CLI から読み取った実際の model / effort（`/status` の表示用）は保存しない
- 起動時の優先順位: 起動オプション（`--claude-model` 等）> 保存した値 > 設定ファイル（`permission`）> 既定値
- 保存した値で起動したときは、起動時の案内に表示する（例: `saved settings: claude permission full`）。`full` が黙って引き継がれないようにする
- 書き込みは一時ファイルに書いてから置き換える。壊れたファイルは保存した値が無いものとして扱う

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
- 認証方式を確認し、サブスクリプション認証でなければ Agent を停止してエラーにする。Codex は起動直後（`account/read`）、Claude は最初のターンまで何も出力しないため、最初のターンの `system/init` で確認する（そのターンは failed になる）

## 終了

Clodex の終了（`/exit`・Ctrl+D・`clodex serve` のシグナル・GUI の終了）では、Clodex が起動したプロセスをすべて止め、終わったのを確かめてから Clodex を終える。

- 止めるもの: 全会話の Agent（Claude / Codex）、実行中の `!command`、Process Manager の process（§15）。どれもプロセスツリーごと止める（Windows では `taskkill /T /F`。親だけを止めると子が残る）
- すべて終わるのを待つ。待つのは最大 10 秒（定数）で、過ぎたら残りを待たずに終える
- GUI が起動した Hub は、GUI が `/exit` を送って最大 15 秒（Hub の上限より長い定数）待つ。それでも Hub が終わらなければ Hub のプロセスツリーごと止める（Hub の node だけを止めると、その子の Agent やシェルが残る）

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

## Solo

片方の Agent だけで作業させるモード。会話ごとに持ち、会話の保存（§18）に `solo` として残す（`/resume`・Hub の再起動の後も続く。新しい会話は通常のモード）。

| コマンド | モード | 動き |
|---|---|---|
| `/solo`・`/solo enable` | `free` | Agent 同士の `send_message` を止める。人は両方の Agent に送れる（送り先を切り替えられる） |
| `/solo claude`・`/solo codex` | その Agent | `free` に加えて、人の送り先をその Agent に固定する。もう片方の Agent は止めず、起動もしない（送れないので待機したまま） |
| `/solo disable` | なし | 通常のモードに戻す |

- 切り替えは、今の会話のどの Agent も作業中でなく、配送待ちの入力・message も無いときだけ受け付ける。それ以外は理由を出して拒否する
- solo の間、Coordinator は `send_message` を拒否する（`ACK` を含む）。拒否の理由は「solo のため、相手に依頼せず自分で行う」
- solo の間、人の入力の末尾に「solo: 相手の Agent に依頼せず、自分で作業する」の 1 行を足す（言語の 1 行と同じ仕組み）。実行中の session は作り直さない
- 送り先が固定されているとき、ほかの Agent への送信（`@<agent>`・`@all`・`!>` の宛先）は拒否する
- 画面: state の会話に `solo` を入れる。Web UI は送り先が固定されていれば、送り先の切り替えをその Agent にして押せなくする。`free` なら切り替えられる。Web UI と TUI の下の行に「solo」を出す。`/status` にも出す

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
| `spec` | | `DELEGATE` / `REVIEW_REQUEST` / `RESULT` のみ。依頼の仕様を書いた設計書の path（project root からの相対パス）。`RESULT` では、`QUESTION` に答えるために更新した設計書を渡す。送信時に通常ファイルとして存在しなければ拒否する（project root の外も拒否） |
| `status` | | RESULT のみ。`approved` / `changes_requested` / `done` / `failed` |
| `issues` | | RESULT / ISSUE のみ。`{ file, line?, severity, summary }` の配列。severity は `low` / `medium` / `high` / `critical` |

Coordinator が付与するフィールド（Agent の自己申告は使わない）:

| field | 内容 |
|---|---|
| `id` | message ID（`msg_` + ランダム 8 桁） |
| `from` | 送信元。MCP の URL path で決める（§12） |
| `repository` | project root（§7） |
| `createdAt` | ISO 8601 |
| `specChanges` | `spec` があり、宛先に同じ設計書を前に渡しているときだけ付ける。前回から変わった節の見出し（下記 Spec の差分）。変わっていなければ空配列 |

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

- `interrupt`（省略可、boolean）: 宛先が送信元からの message を処理中なら、そのターンに足す（§28 v0.3 C）。それ以外は通常どおり配送する

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
- tool は `send_message`（入力 schema は §11）と `ask_user`（下記）の 2 つ

## 配送ルール（v0.1）

- Agent ごとに mailbox（FIFO キュー）を持ち、人間の入力と formal message を同じキューで直列に送る。実行中のターンには割り込まない
- 宛先 Agent が stopped なら、送る前に起動する。以前の session ID があれば resume する（Lazy Start: Agent は必要になるまで起動しない。§3.2）
- `ACK` は記録のみで宛先に配送しない（ACK の往復で Agent を起こさない。§25）
- 送信元への tool 応答は受理結果（message ID）だけを返す。返信は送信元の現在のターンが終わった後、新しいターンとして届く
- 起動や送信に失敗したら Event Bus に `error` を出し、mailbox は次の項目へ進む。人の入力・`/compact`・`RESULT`・`ISSUE` は再送しない
- 作業を頼む message（`DELEGATE`・`REVIEW_REQUEST`・`QUESTION`）は、配送したターンが失敗（`failed`。混雑や API のエラー）したら 30 秒待って、同じ envelope をもう一度だけ宛先の mailbox に積む。取り消し（`/interrupt`・`/cancel`）と停止（mailbox を閉じた）は失敗に数えない。宛先が利用枠の上限で待っているときも送り直さない（リセット後に続きを送るため。§利用枠の可視化と通知）
  - もう一度失敗したら、送信元の mailbox に「宛先に届かなかった。送り直さずに自分で進める」という指示（英語。message の type・ID・宛先・エラーの 1 行目）を積み、画面に notice（「{to} への {type} が 2 回失敗。{from} が自分で進める」）を出す。`DELEGATE` は自分で実装し、`REVIEW_REQUEST` は自分で確かめ、`QUESTION` は自分で判断して進める
  - 待っている間に Hub が止まったら、再試行はしない（未配送分としても残らない）
- `/new`・`/resume` で Agent を止める間は、その Agent の mailbox の配送を止める。止めている間に届いた項目は捨てず、切り替え後の session に配送する
- Coordinator の停止時は、先に全 mailbox を閉じてから Agent を止める（停止中に Agent を再起動しない）。未配送分と作業中だったことは、閉じる前の状態として保存してあり、次の起動で戻す（§18 Hub の再起動からの復旧）

## 人への質問（`ask_user`）

Agent が人に判断を求めるとき、文章の中に質問を書かせず、選択肢つきの質問として画面に出して答えられるようにする（Claude Code の AskUserQuestion に相当）。Claude / Codex のどちらでも同じ形にするため、各 CLI の組み込みの質問機能ではなく Clodex の MCP tool にする。

- 入力: `{ questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string; recommended?: boolean }>; multiSelect?: boolean }> }`。質問は 1〜4 件、選択肢は 2〜6 件。推奨は label や description に書かず `recommended` で印を付け、description は選択肢を比べるための短い 1 文にする（tool の schema の説明で伝える）。人は選択肢のほかに自由に書いて答えることもできる（「その他」）
- tool は待たずにすぐ返す（受理した質問の ID と「ターンを終えて回答を待つ」旨）。回答は人が答えた後、その Agent への新しいターンとして届く（`send_message` の返信と同じ。CLI の tool の timeout に左右されない）
- Coordinator は質問を Event Bus の `question` event（`{ id, agent, questions }`）として出す。feed に流して保存し、画面は回答の欄つきの質問欄に出す（Web UI）
- 回答は `/answer <質問 ID> <回答>` で送る（画面のボタンもこれを送るだけ。§17 の入力の決まり）。`<回答>` は JSON の `string[][]`（質問ごとに選んだ label か自由記述）。Coordinator は `answer` event（`{ id, answers }`）を出し、質問した Agent の mailbox に人間の入力として「質問と回答」の文章を入れる
- 答えていない質問は会話ごとに持つ（未回答の一覧は `state` に入れる）。同じ質問への 2 度目の回答・存在しない ID は拒否する。`/new`・`/resume` で Agent の session が変わっても回答はその Agent に届ける
- 人が回答せずに普通の入力を送ってもよい（質問は未回答のまま残る）
- Claude の組み込みの `AskUserQuestion` は `--disallowedTools AskUserQuestion` で使わせない（stream-json では人が答えられないため）。両 Agent の指示（§13 Roles と同じ場所）に「人に判断を求めるときは `ask_user` を使う」と書く

---

# 13. Context Resolver

Agent B に渡す Context は Task envelope を基本とする。formal message（§11）から決定論的に組み立て、宛先 Agent への 1 ターン分の入力として送る。

```text
[Clodex] Message msg_1a2b3c4d from claude
Type: REVIEW_REQUEST
Task: AUTH-142
Repository: C:\dev\my-app
Commit: a82f39c
Spec: docs/specs/AUTH-142.md
Files:
- src/auth/refresh.ts

refresh token の race condition をレビュー

Read the spec before you start and follow it. If the spec conflicts with the code or is unclear, ask with a QUESTION instead of guessing.
Reply with the send_message tool of the "clodex" MCP server (not a shell command): to="claude", type="RESULT", taskId="AUTH-142", replyTo="msg_1a2b3c4d".
Put findings in issues (file, line, severity, summary). Do not paste large content; reference files and commits.
Write body in Markdown: a one-line summary first, then bullet points. Do not write one long paragraph.
```

- 依頼系（`QUESTION` / `REVIEW_REQUEST` / `DELEGATE`）には返信方法を指示する。返信の body の書式（Markdown で 1 行の要約 → 箇条書き。長い 1 段落にしない）も添え、Agent ごとに書き方がばらつかないようにする
- 末尾に、人が読む文章の言語（下記 Language）を 1 行で添える。長い会話でも依頼のたびに思い出させる
- `RESULT` / `ISSUE` には返信を求めない（返信の連鎖を作らない）
- 会話履歴は含めない。Agent B は必要に応じて Repository を読む
- `spec` があれば `Spec:` 行と「作業の前に読んで従う。コードと食い違う・曖昧なら推測せず QUESTION で聞く」の 1 行を添える。`RESULT` では「回答に合わせて更新した設計書を読み、続きの作業で従う」の 1 行にする
- `specChanges` があれば `Spec:` 行の直後に書く。空なら `Spec:` 行に `(unchanged since you last received it)` を付け、空でなければ `Spec changes since you last received it:` に続けて節の見出しを 1 行ずつ並べる

## Spec（設計書）

依頼の詳細は body ではなく、リポジトリの中の設計書に書いて `spec` で渡す。body は 4,000 文字までの要約なので詳細を書き切れず、会話にしか残らない。設計書なら相手が何度でも読み返せ、コミットして履歴にも残る。

- 既定の置き場所は `docs/specs/<taskId>.md`。project の CLAUDE.md / AGENTS.md や役割で別の場所を指示してもよい
- `DELEGATE` / `REVIEW_REQUEST` は設計書を書いて `spec` を付けるのを基本にする。body だけで済ませるのは、数行で説明しきれる簡単な依頼だけ
- `QUESTION` に答えるために設計書を直したら、`RESULT` の `spec` で渡す。`files` に載せるより、読んで従うものだと確実に伝わる
- 設計書の作成・更新・コミットは送信元の Agent が行う。Coordinator は存在を確かめるだけで中身は見ない
- 役割の定型文（§13 Roles）でこの方針を伝える

### Spec の差分

QUESTION と次の依頼の間に設計書へ書き足すと、受け手はどこが新しいか分からず全文を読み直すことになる。Coordinator は変わった節の見出しを envelope に添える。

- Coordinator は `spec` 付きの message を受理するたびに、宛先 Agent ごと・設計書（実パス）ごとに中身を記録する。記録はメモリだけで、Clodex を起動し直すと消える
- 同じ宛先に同じ設計書を前に渡していれば、前回の中身と比べて `specChanges` を付ける。初めて渡すときは付けない
- 節は Markdown の ATX 見出し（`#` 〜 `######`）で区切る。code fence の中の `#` は見出しとみなさない。最初の見出しより前は `(top)` とする
- 見出しの行から次の見出しの直前までを節の中身とし、中身が変わった節と新しい節を見出しの行のまま並べる。消えた節は `(removed) ` を前に付ける。改行コードと行末の空白の違いは無視する
- 全文の diff ではなく見出しにするのは、envelope を短く保つため（§3.3）。中身は受け手が設計書を開いて読む
- 並べる節は 20 件まで。超えた分は `…and N more` の 1 行にまとめる

## Native configuration

以下を巨大な共通 prompt に結合しない。

```text
CLAUDE.md → Claude
AGENTS.md → Codex
```

`AGENTS.md` が無い project では、Codex にも `CLAUDE.md` を読ませる（起動引数の `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'`）。project ごとに同じ内容の `AGENTS.md` を置かずに済むようにするため。`AGENTS.md` があればそちらを使う（docs/spikes/codex-project-config.md）。

将来的に共有 artifact を置く場合:

```text
.ai/
├── project.md
├── architecture.md
└── decisions/
    └── ADR-003.md
```

ただし全 Agent が常時すべて読む設計にはしない。依頼ごとの設計書は上の Spec（`docs/specs/<taskId>.md`）に置く。

## Language

人が読む文章（Agent の方針・途中の発言・最終応答・`send_message` の本文、Clodex の画面）の言語。

- 設定ファイルの `language`（`ja` / `en`）。無ければ OS のロケールから決める（`ja` で始まれば `ja`、それ以外は `en`）
- Agent には system prompt の定型文と Task envelope の末尾で「人が読む文章はすべてこの言語で書く。コード・識別子・コマンド・パスはそのまま」と指示する。指示の本体（定型文・envelope）はモデル向けなので英語のまま
- さらに、人の入力（割り込みを含む）を Agent に渡すときは、末尾に言語の 1 行（例: `[Clodex] Write your reply and every progress note between tool calls in Japanese.`）を足す。system prompt の指示は長い会話で弱まり、`/resume` した session には入っていないこともあるため、直近の指示として毎回添える。画面・履歴・送信待ちには人が打った本文だけを出す
- 守られることは保証できない（自動翻訳はしない）。英語が残る場合は指示の文言を見直す
- Clodex の画面の文言（Web UI・CLI・通知）もこの言語で出す（§28 v0.3 の i18n）
- `/language` で変えると、Clodex の画面はすぐに切り替える（Web UI は画面の版が変わるので再読み込みする）。Agent に毎回添える言語の 1 行も次の入力から変わる。system prompt の指示は、次に始める session から変わる

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
- `worktree.setup` は `/new worktree` の直後に worktree で実行する command（§28 D1）
- `updateChannel`（`stable` / `dev`、既定 `stable`）は GUI の更新の取得先（§28 GUI の自動更新）。GUI はユーザーの設定だけを読む
- `~/.clodex/config.json` が無ければ、起動時に役割を空にしたひな形を作る（`{ "roles": { "claude": "", "codex": "" } }`）。役割の文章は書かない（書くのは人）。既にあれば触らない。作れなくても起動は続ける
- 役割の空文字は未設定として扱う（ひな形のままでも、役割が無いのと同じ）
- UTF-8（BOM の有無は問わない。Windows PowerShell 5.1 は BOM 付きで書く）
- 優先順位: 起動オプション > project の設定 > ユーザーの設定 > 既定値（primary: `claude`、roles: なし）
- Coordinator は Agent の起動時に、固定の定型文と役割を system prompt に追加する（Claude: `--append-system-prompt`、Codex: thread の `developerInstructions`）。定型文は「相手の Agent がいること」「自分と相手の役割」「相手の役割の作業は `send_message` で依頼すること」「権限は人が `/permission` で変えるので、拒否されたらそう伝えること」「依頼を受けたら、作業に入る前に何をするかを 1〜2 文で書くこと」「`send_message` の body は Markdown で 1 行の要約 → 箇条書きで書くこと」「依頼（`DELEGATE` / `REVIEW_REQUEST`）は基本的に設計書を書いて `spec` で渡し、body だけにするのは数行で済む簡単な依頼に限ること。QUESTION に答えるために設計書を直したら RESULT の `spec` で渡すこと（上の Spec）」「人が読む文章の言語（下記 Language）」を伝える
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

## 上限

既定値は `coordinator/budget-manager.ts` の定数で、設定ファイル（§13 Roles）の `limits` で変更できる。既定値は、分業の流れ（設計 → 実装の委譲 → レビュー → 修正の委譲）が上限に当たらないように決めている。

| 上限 | 既定値 | 数え方 |
|---|---|---|
| `maxMessagesPerChain` | 8 | chain 内の message 数（ACK 以外） |
| `maxReviewRoundsPerChain` | 3 | chain 内の `REVIEW_REQUEST` 数 |
| `maxDelegationsPerChain` | 4 | chain 内の `DELEGATE` + `QUESTION` 数 |
| `maxDelegationDepth` | 2 | 依頼の入れ子の深さ（下記） |

依頼の深さ:

- 人間の入力によるターン中に送った依頼は深さ 1
- 依頼（`QUESTION` / `REVIEW_REQUEST` / `DELEGATE`）を処理中に送った依頼は、処理中の依頼の深さ + 1
- 結果（`RESULT` / `ISSUE`）を処理中に送った依頼は、処理中の message と同じ深さ（2 回目のレビュー依頼など、同じ階層での継続）
- 依頼以外の message の深さは、処理中の message と同じ（無ければ 1）

上限を超える message は受理せず、送信元へ tool エラーで理由を返し、Event Bus に `error` を出す。エラー文では「上限に達したので人間に報告する」よう Agent に促す。人に見せる `error` には変え方を添える（例: `maxMessagesPerChain (8) に到達（/limits messages <n>）`）。

人は `/limits` で上限を表示・変更できる:

- `/limits`: 4 つの上限の今の値と、既定値から変わっているかを表示する
- `/limits <name> <n>`: 上限を変える。`name` は `messages`（`maxMessagesPerChain`）・`reviews`（`maxReviewRoundsPerChain`）・`delegations`（`maxDelegationsPerChain`）・`depth`（`maxDelegationDepth`）。`n` は 1〜100 の整数。範囲外・不明な名前は使い方を表示する
- `/limits reset`: 保存した値を消し、設定ファイル（無ければ既定値）に戻す。無制限も解除する
- `/limits unlimited`: 4 つの上限をすべて無くす（無制限）。`.settings.json` に `limitsUnlimited: true` として保存する。`/limits <name> <n>` で値を変えるか `/limits reset` で解除する。無制限の間も chain は数える（`/interrupt` で閉じた chain の拒否は今どおり）。`/limits` の表示と起動時の案内に「無制限」と出す
- 設定画面の上限の欄に「無制限」を置く（押すと `/limits unlimited`。無制限の間は押された状態）
- 反映は即時。進行中の chain にも新しい上限を使う（上限に当たって止まったやり取りを、上げてから続けられるように）
- 対象は project 全体（その project のすべての会話の Coordinator）
- 変えた値は project ごとに保存する（§9「Agent の設定の保存」の `.settings.json` の `limits`）。起動時の優先順位は、保存した値 > 設定ファイルの `limits` > 既定値。保存した値で起動したときは起動時の案内に表示する（例: `saved settings: limits messages 16`）

## 利用枠の可視化と通知（v0.2）

Agent Adapter の `rate_limit` event（Claude: `rate_limit_event`、Codex: `account/rateLimits/updated`）から、Agent ごとに最新の利用状況を保持する。

- **週のペース超過** = 週の使用率 − 週の経過率（経過率は reset 時刻と週の長さ 7 日から計算）。正なら使いすぎ、負なら余裕あり
- `/status` に、各 Agent の 5 時間枠の使用率と週のペース超過、コンテキストの大きさ、現在の primary を表示する。まだ受け取っていない値は `unknown`
- コンテキストの大きさは、その Agent の session が変わったとき（`session` event、`/new`、`/resume`）と compact したとき（`compacted` event）に unknown に戻す
- Clodex の起動時に、model の一覧と同じ短命のプロセスで両 Agent の利用状況も取得し、Agent の Lazy Start を待たずに表示する（docs/spikes/model-list.md）。ターンを送らないので利用枠を消費しない。取得は Hub で 1 回、全 project の UsageMonitor に `rate_limit` event と同じ形で渡す（通知の判定も同じ経路）
  - Claude: `control_request` の `get_usage` の `rate_limits.five_hour` / `seven_day`。`utilization` は 0〜100 の percent、`resets_at` は ISO 8601 の文字列（`rate_limit_event` の比率・epoch 秒とは形式が違うので変換する）
  - Codex: `account/rateLimits/read` の `rateLimits.primary` / `secondary`（`windowDurationMins` で 5 時間・週を見分ける。今の Adapter と同じ変換）
- その後はターン中の `rate_limit` event で更新する。起動時に取得した値より新しい event が来れば上書きする
- 次の条件を初めて満たしたとき、1 回だけ通知する（同じ条件では繰り返さない。reset 後は再び通知できる）

| 条件 | 既定の閾値 | 通知例 |
|---|---|---|
| 週のペース超過が閾値以上 | +15 ポイント | `[CLODEX] claude is ahead of weekly pace (+18). Try /primary codex` |
| 5 時間枠の使用率が閾値以上 | 90% | `[CLODEX] claude 5h usage: 92%` |

- 閾値は設定ファイルの `usageAlert` で変更できる
- 送り先の切り替えは自動で行わない（§3.6）。人が `/primary` で切り替える

上限での停止と自動再開:

- 上限に達したときの CLI の出力（エラーの文言・種類）は実測できていないので、文言では判定しない。Agent に送ったターンが失敗（`failed`）し、その時点でその Agent の最新の利用状況に、使用率が 100% 以上でリセット前の枠（5 時間・週）があれば、上限で止まったとみなす（リセット時刻は、該当する枠のうち遅いもの）
- 上限で止まったら、その Agent の mailbox の配送を止め（残りの項目は捨てずに待たせる。続けて送って失敗させない）、notice（「{agent} が利用枠の上限。{時刻} に再開」）を出す
- リセット時刻の 1 分後に、mailbox の先頭に「利用枠が戻った。止まった作業を続ける」の指示（英語。人の入力と同じく言語の 1 行を添える）を積んで配送を再開する。止まったターンの入力は session に残っているので送り直さない
- 待っている Agent は復旧の状態で「作業中だった」に含める。Hub を再起動したら、復旧の「続き」を送り、まだ上限なら同じ判定でまた待つ
- 待っている間に人が `/interrupt` したら、待つのをやめ、続きの指示は積まずに配送を再開する

## 将来

mode（economy 等）、CLI の利用率 telemetry（`rate_limit` event）による制御、`/budget` 表示。

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

dev server のように終わらない command を `!& <command>` で background process として動かす。人間が見るためのもので、Agent には渡さない（`!command` と同じ）。

```text
> !& pnpm dev
#1 started: pnpm dev

> /processes
#1 running 12.3s  pnpm dev
```

- 起動は `!command` と同じ（PowerShell、UTF-8 の出力、終了コードの扱い。§8）。作業場所は起動したときの今の会話の作業場所
- 番号は Hub の中で 1 から振り、使い回さない。一覧は Hub で 1 つ（project・会話をまたぐ）。終わった process も Hub の終了まで一覧に残す
- 出力は feed に流さない。process ごとに最後の 200 行（定数）を持ち、`/processes <番号>` で表示する
- 起動したとき・終わったときに 1 行出す（`#1 started: pnpm dev`、`#1 exit 1 (3.2s): pnpm dev`、止めたときは `#1 stopped (3.2s): pnpm dev`）
- `/kill <番号>` でプロセスツリーごと止める。Ctrl+C と `/interrupt` では止めない（Agent のターンや `!command` を止めるたびに dev server が落ちないように）。`/exit` と Hub の終了ではすべて止める
- state に一覧（番号・command・状態）を入れ、`/processes`・`/kill` の引数の候補に使う

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

ログの保持: `~/.clodex/logs` は起動のたびにファイルが増えるので、Hub（同じプロセスで動く CLI を含む）の起動時に、更新日時が 14 日より前のファイルを消す。対象は `.jsonl`（Event Log）と `.log`（GUI が書く Hub の stderr・Hub のエラーのログ）だけで、ほかのファイルとディレクトリには触れない。消せなかったファイルは飛ばし、起動は止めない。既に動いている Hub につなぐだけの CLI では消さない

terminal の表示（「誰が何をしていて、誰が誰に何を頼んだか」だけを追えるようにする）:

| event | 既定 | `/verbose` |
|---|---|---|
| ターン開始（`turn_started`） | `[CLAUDE] working...` | ✓ |
| ターン完了（`turn`） | 最終応答。interrupted / failed はその旨 | ✓ |
| formal message | `[MESSAGE] claude -> codex REVIEW_REQUEST task=... ` と本文の先頭 | ✓ |
| `error` | ✓ | ✓ |
| 通知（`notice`） | `[CLODEX] ...` | ✓ |
| 人間の入力（`human`） | ×（入力行が画面に残っているため） | ✓ |
| ターンの最初の発言（方針。`text`） | ✓ | ✓ |
| 途中の発言（2 つ目以降の `text`）・`tool`・`rate_limit`・`session`・`exit` | × | ✓ |

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
| `output` | コマンドの出力（`/help` 等、Shell が表示する行）。`!command` の開始と終了の行には `command: { id, phase: "start" \| "exit" }` を付ける（画面が実行中の経過時間を出すため。並行して実行できるので id で対応を取る） |
| `state` | 状態のスナップショット（下記）。変化があるたびに送る（短い間隔の変化はまとめる） |
| `reset` | 今の会話が変わった（`/new`、`/resume`）。画面はログを消し、続けて送られる切り替え先の会話の履歴を表示する |
| `toast` | 会話の中身ではない一時的な知らせ（`{ text, level: "info" \| "warn" }`）。画面はポップアップで出し、ログには入れない。保存も再送もしない（下記） |
| `version` | 画面の版（画面の HTML・CSS・JS から作るハッシュ）。開いている画面の版と違えば、画面は再読み込みする（Clodex を更新して起動し直したとき、古い画面のまま使わない） |

- 接続時と会話の切り替え時に送る履歴は、今の会話の直近 200 件（`INITIAL_HISTORY_ITEMS`）の `event` / `output` だけにする（長い会話でも開く・切り替えるときに待たせない）。続けて最新の `state` を送り、以後は新しいものを流す
- それより前は `GET /api/history?before=<seq>&limit=<n>` で読む（今の会話の、通し番号が `before` より小さい項目の直近 `n` 件。`n` の既定と上限は 200）。応答は `{ items, hasMore }`。Hub はメモリに今の会話の直近 1,000 件を持ち、その範囲を返す
- 画面と TUI は、ログを読み返して一番上（読み込んだ端）に近づいたら前の 200 件を読み、上に足す。足しても見ている位置は動かさない。`hasMore` が false なら以後は読まない。読んでいる間に会話が切り替わったら（`reset`）、その応答は捨てる
- ターンは複数の event から組み立てるので、前の項目を足したら、持っている全項目からログを組み立て直す（読み込みの境目で分かれたターンを 1 つに戻す）
- 次の知らせは `toast` で送り、ログ（`output` / `notice`）に入れない。会話の中身を汚さないため
  - 会話・project の操作の結果: `/new`（worktree を含む）・`/resume`・`/rename`・`/delete`・`/pin`・`/project <path>` の完了と失敗
  - ほかの会話で Agent のターンが終わったこと（§28 D1）
  - 同じ作業場所で別の会話が作業中であること（§28 D1）
  - terminal（TUI でない行ごとの表示）には今どおり 1 行で出す
- `event` / `output` は会話ごとにファイルにも保存する（§18）。`clodex` を起動し直しても、`/resume` で戻っても、その会話の流れを表示できる
- `agent` event のうち、ログに表示するもの（`turn_started` / `text` / `tool` / `turn` / `error` / `compacted` / `steer_delivered`）だけを feed に流して保存する。それ以外（`session` / `rate_limit` / `context` / `exit`）は `state` に反映するだけにする（頻繁な `context` で直近 1,000 件の枠を使い切らない）
- 保存した feed を読み込んだとき、終わっていない（`turn` が無い）ターンは中断したものとして表示する（作業中のまま残さない）。ただし、その会話の runtime でその Agent が今も作業中（`busy` / `starting`）なら作業中のまま残す（会話を切り替えて戻っても、裏で動いているターンを中断扱いにしない）
- Hub が project を開いたとき（その project のターンがまだ 1 つも動いていない時点）に、その project のすべての会話の feed で終わっていないターンを、中断（`turn` の `interrupted`）の event をファイルに書き足して閉じる。前の Hub が作業中に止まったターンを、復旧で同じ Agent が作業を始めても作業中のまま残さないため
- 画面は、ある Agent のターンが始まったら、その Agent の作業中のターンを中断にする（1 つの Agent が同時に動かすターンは 1 つ。上の対処の前に保存された feed にも効く）
- 状態のスナップショット: primary、各 Agent の状態・権限・model / effort・session・利用枠・コンテキスト（`/status` と同じ内容）、会話の一覧と今の会話、project の sandbox（on / off、セットアップ済みか）、上限（4 つの今の値と既定値）、言語

### 入力

- terminal と同じ `parseInput` / Shell を通す（§8）。テキスト、`@claude` / `@codex`、全スラッシュコマンドが使える
- 画面のボタン（権限、Interrupt、Compact、New、会話の切り替え、primary）は、対応するスラッシュコマンドを送るだけにする。Web 専用の操作経路を作らない

### 画面

レイアウト:

- PC（幅 900px 以上かつマウス操作の端末）:
  - ヘッダ: 左に「Clodex」と project の pill（folder アイコン + project 名 + chevron。押すと project の一覧。パスは pill の `title` に出し、本文に重ねて出さない）と「project を開く」。右にアイコンのトレイ（作業中、詳細、成果物、テーマ、設定）
  - 左の列: 会話の一覧（見出しに「新しい会話」のアイコン）
  - 右の列: 上に **Agent ストリップ**（Agent ごとのカードを横に 2 枚。mark・名前・状態 pill・model / effort / 権限・コンテキスト / 5 時間 / 週のミニゲージ・中断 / Compact / 設定のアイコン）、その下にログと入力欄。ミニゲージを押すと、カードの下に利用状況のポップオーバー（コンテキストの使用量と上限、5 時間・週の使用率・reset 時刻・ペース）を開く（外のクリックか Esc で閉じる）
  - 画面が広いとき: 会話の一覧は常に左端に置き、右の列（Agent ストリップ・ログ・入力欄）は今の最大幅（1060px）のまま画面の中央に置く（会話の一覧と重なるなら、重ならない位置まで右へ寄せる）。右の余白が利用状況のパネルを置けるほど空いたら（幅 1700px 以上）、右端に両 Agent の利用状況（ポップオーバーと同じ中身）を常に出し、ミニゲージのポップオーバーは開かない
- スマホ（上以外）: PC の縮小ではなく、チャットアプリの形にする
  - ヘッダは 1 行（48px + safe-area）: 左に会話のドロワーを開く ≡、中央に会話名（下に小さく project 名）、右に Agent ピル 2 つ（状態の点 + コンテキストの円環。`full` は点の横の小さな盾）と ⋯（成果物・テーマ・設定・詳細・project）。Agent ごとの状態の行は置かない
  - Agent ピルを押すと、その Agent のシート（設定の要約、利用枠と reset 時刻、中断 / Compact / 設定の 44px ボタン）が下から開く
  - 会話の一覧は左からのドロワー（幅 86%、上に「新しい会話」、下に project の選択）
  - ログは全幅。mark は見出しの行の中に置き、本文の左に列を作らない
  - 入力欄: [送り先の mark（押すと切り替え）][入力欄][画像][送信]。作業中は入力欄の上に浮く pill（0 件なら出さない）。未回答の質問は入力欄の上の質問欄に出す
  - 入力中（ソフトキーボードの表示中）はヘッダを隠し、ログの面積を確保する（`visualViewport` で高さを合わせる）
  - 操作できる部品は 44px 以上
- Agent の「設定」は、役割の編集・権限・model・effort と「この Agent だけ session を始め直す」（`/new <agent>`）をまとめたポップアップを開く。開くのは Agent カード（スマホは Agent のシート）の設定ボタンだけ。model / effort / 権限の表示は押せない（同じ操作の入り口を 2 つにしない）
- テーマのボタンは押すたびに システム → ライト → ダーク と切り替える。アイコンは今のテーマ（モニター / 太陽 / 月）。選択はその端末のブラウザに保存する
- 「設定」のポップアップには、画面のボタンでは変えられない Hub・project の設定を置く。送り先・作業と全文・テーマは置かない（それぞれのボタンで切り替える）
- 設定は効く範囲で 3 つの節に分け、この順に並べる。節には見出しを付け、節の間は区切る。項目のない節は見出しごと出さない
  - **プロジェクト**: sandbox・上限
    - **sandbox**: off / on の選択と、今の状態（セットアップ済みか）。選ぶと `/sandbox on|off` を送る。切り替えの間はトップのバーを出す
    - **上限**: 4 つの上限（§14）を数値で変える。既定値と違う項目は分かるようにする。適用で `/limits <name> <n>`、「既定に戻す」で `/limits reset` を送る
  - **端末**: 送信キー・通知
    - **送信キー**: 「Enter で送信」/「Ctrl+Enter で送信」。端末の localStorage に保存し、Hub には送らない。スマホでは出さない
    - **通知**: 下記 Web Push（§28）
  - **Clodex**: 言語・GUI の版と更新
    - **言語**: 日本語 / English。選ぶと `/language <ja|en>` を送る
    - **GUI の版と更新**: 下記 GUI の自動更新（§28）。GUI につながっていないときは出さない
- 各項目は 1 行にまとめ、PC では左に名前・右に操作を置く。狭い画面（スマホ）では名前の下に操作を置く。補足（sandbox の状態、上限の既定値）は名前の下に小さく出す。上限は 4 行を名前・数値・適用・既定値の列で揃え、「既定に戻す」「無制限」は表の下の右に置く
- ポップアップ（シート）は、スマホではつまみ付きで下から開き（下へのスワイプでも閉じる。高さは `80dvh` まで）、PC では画面中央のモーダルとして開く（背景を暗くし、背景のクリックか Esc で閉じる）
- 会話の一覧の各項目の「⋯」から、名前の変更（今の会話のみ）・ピン止め・削除（今の会話以外）を行う

ログ:

- 人間の入力、各 Agent のターン、Agent 間の message、通知、エラー、コマンドの出力を時系列に並べる
- Agent のターンは次の順に表示する。指示してから完了するまでの様子が、チャット欄を増やさずに分かるようにする
  - **方針**: ターンの最初の発言。常に表示し、完了後も残す。最終応答と同じ内容（発言が 1 つだけのターン）なら出さない
  - **作業**: 2 つ目以降の発言と tool 呼び出しを起きた順に並べる（既定は畳む。上部の「詳細」で一括して開閉）
  - **今の作業**: 作業中だけ、直近の発言か tool を 1 行で出し、新しいものが来たら同じ行を書き換える。経過時間を添える。完了したら消す
  - **最終応答**: 本文として表示する
- ターンの作業中に、そのターンより後ろに別の項目（人間の入力・message・質問・ほかの Agent の終わったターンなど。作業中のターンと、そのターンの Agent 自身が送った質問・message は除く）が並んだら、最終応答はターンの枠に入れず、届いた時点のログの末尾に新しい項目として出す（ログを時系列に保つ）。元の枠には方針と作業だけを残し、状態と最終応答は出さない。方針も作業も残らない枠は消す
  - 最終応答の項目の見出しに元の枠へ跳ぶボタン（↑）、元の枠の見出しに最終応答へ跳ぶボタン（↓）を置く。押すと相手の項目を画面の中央までスクロールし、少しの間強調する
  - Agent の質問と message は、もともと送った時点で末尾に並ぶ。自分の質問・message だけが後ろに並んだときは最終応答を元の枠に入れ、枠の直後に質問・message が続くようにする（同じ Agent の項目が細切れにならないように）
- Agent の応答・Agent 間の message の本文・人間の入力は GFM（GitHub Flavored Markdown）として表示する。解析は自前で書かず `marked` を使い、Web UI と TUI で同じ解析結果を使う
  - 対象: 段落、改行（単独の改行も `<br>` にする。`breaks: true`）、見出し、太字・斜体・取り消し線、インラインコード、コードブロック、箇条書き・番号付きリスト（入れ子を含む。書かれた番号から始める）、引用（`>`）、表、区切り線、リンク
  - 生の HTML は描画せず、文字としてエスケープして表示する（Agent や人の入力に `<script>` などが混ざっても実行しない）。リンクは `http:` / `https:` だけをリンクにし、新しいタブで開く（`rel="noopener noreferrer"`）。それ以外の URL は文字のまま
  - Web UI のクライアントは `toString()` でページに埋め込むため、`marked` のブラウザ用ビルド（UMD）をページに埋め込む
- Agent 間の message は、送信元 → 宛先、種類、本文、関連ファイル、指摘（severity 付き）、相手に渡した全文（畳む）を表示する
- Agent の質問（§12 `ask_user`）は、未回答のものをログの外の「質問欄」に出す。質問欄は入力欄の上にくっつけて置き、ログのスクロールに影響されない
  - 出すのは state の未回答の質問（`questions`）の最も古い 1 組。1 組の中の質問は 1 問ずつ出す: 見出し・質問文・選択肢のボタン（説明を添える。`recommended` は label の横に星のアイコン。`multiSelect` はチェック）・「その他」の入力欄
  - 単一選択の選択肢を押したら、次の未回答の質問へ進む。複数選択と「その他」は「次へ」で進む（「その他」は Enter でも進む）。「前へ」と、質問ごとの点（回答済みかを示す）で前の質問に戻れる。回答は 1 組まとめて送るので、すべて答えたら「回答」を押せる
  - 見出しの行に Agent・何問目か（`1/3`）・ほかに待っている組の数を出す。見出しの行を押すと質問欄を畳む／開く（畳むと見出しの行だけ）。スマホでも畳んでログを見られる。開いているときの高さは画面の半分までにし、超えたら質問欄の中でスクロールする
  - 回答の下書き（選んだもの・入力・何問目か）は組ごとに画面で持ち、畳んでも消えない
  - ログには、未回答の質問は「回答待ち」の 1 行だけを出す。回答したら、質問ごとに質問文と回答を並べた記録にする
  - 件数の pill（作業中パネルのボタンと同じ並び）は出さない
- TUI は質問をカード（質問文と番号つきの選択肢）として出し、回答は `/answer` で送る。`/answer` の引数の候補に未回答の質問 ID（説明は最初の質問文）を出す

部品:

- 全部品の質感を送り先の切り替えにそろえる: くぼんだ下地（`--sunken`）の上に、選んだものが `--panel` で浮く（1px の ring で縁取る。白黒反転にしない）。角丸は入れ子でそろえる。Agent の色は小さな点や細い線で使い、面を塗らない。白黒反転の主ボタンは 1 画面に 1 つまで
- 操作できる部品はすべて hover / 押下 / 選択中 / 押せない / focus-visible / 処理中の見た目を持つ。押せないときは意味の色（赤など）も消す。変化は 120ms 程度の transition にし、`prefers-reduced-motion` では止める
- ヘッダと操作のボタンは文字を出さずアイコンだけにする。`aria-label` と `title` を必ず付け、PC は hover で tooltip を出す（ボタンの下。画面の下端にある入力欄のボタンは、はみ出さないよう上）。アイコンは inline SVG の `<symbol>` にまとめる（Lucide 相当の線のアイコン。依存パッケージは増やさない）。送り先や選択肢（`.seg`）は文字のまま
- 送信ボタンと入力欄の focus の縁（内側の線と外側の薄い縁）は、選んでいる送り先の色にする。外側の薄い縁は入力欄の要素で送り先の色から作る（祖先で計算した色を引き継がない）。`!command` の入力中は送り先に関係なく緑（`--code`）にし、送り先の切り替えの位置に「コマンド」の印を出す（入力欄の上に行を足さない。入力欄の高さを変えない）

待ちの表示:

- ユーザーが待つところは必ず見えるようにする。共通の部品は 3 つ
  - **トップのバー**: ヘッダの下端の 2px の不確定のプログレスバー。初回の接続から最初の `state` まで、会話・project の切り替え、`/new`、sandbox の切り替えの間に出す
  - **ボタンの処理中**: 押したボタンは、送ったコマンドの応答（`/api/input` の完了）か、待っている `state` の変化が来るまで、押せなくしてスピナーに置き換える（幅は変えない）。二度押しを防ぐ
  - **skeleton**: 最初の `state` が届くまで、ログ・Agent ストリップ・会話の一覧に仮の行を出す（「メッセージはまだありません」を出さない）
- `state` の変化を待つ設定（model・effort・権限）は、`/primary` と同じく選んだ値を「適用待ち」として表示し、反映されたら外す（古い値に戻して見せない）
- Agent の起動中（`starting`）と、送ってから `turn_started` が来るまでは、ログの末尾に宛先の Agent の「起動中…」の仮のターンを出す
- 再接続の帯にはスピナーを付ける。再接続をあきらめた（EventSource が閉じた）ら「再読み込み」ボタンに変える。再接続した直後はログを消さず、届いた履歴で差し替える
- そのほか: 前の履歴を読んでいる間はログの先頭に読み込み中の行、画像のアップロード中は入力欄の上にチップ（終わるまで送信できない）、`!command` の実行中は出力の頭に経過時間

使い勝手の決まり:

- **ページの横スクロールを発生させない**。長いコマンド・JSON・全文は折り返す。表だけはブロックの中で横スクロールし、端の影でスクロールできることを示す。長いコードブロックは高さを抑えて畳み、「全文」で開く
- 読み返している間に新しい項目が来ても勝手にスクロールしない。一番下にいないときは「新着」ボタンを出す
- 入力: PC は既定で Enter で送信（Shift+Enter で改行）。設定の「送信キー」で「Ctrl+Enter で送信」（Enter と Shift+Enter で改行）に切り替えられる。設定は端末ごとに localStorage に保存する（PC とスマホでキーボードが違うため）。スマホは設定によらず Enter で改行し、送信はボタン（日本語入力の確定と誤送信を防ぐ）。判定は 1 つの純関数にする
- 候補（`/`・`@` のサジェスト）が出ていても、Enter は候補を確定せず入力の扱い（送信か改行）のまま。候補の確定は Tab だけ、選ぶのは ↑↓、閉じるのは Esc（TUI も同じ）
- 入力欄の文字は本文と同じ大きさにする。iOS が入力欄のフォーカスで画面を拡大しないよう、スマホの入力欄は 16px にする
- 送り先は入力欄の切り替えで選ぶ（既定は primary）。`/`・`@`・`!` で始まる入力はそのまま送る（`!command` も terminal と同じく実行する）
- 開いているシート（Agent の操作・設定）は、`state` が届いたら表示中の値だけを更新する。DOM を作り直さない（タップ中のボタンを差し替えない）
- 接続が切れている間はその旨を表示し、自動で再接続する
- `toast` は画面の上部（PC は右上）に重ねて出し、4 秒で消す。押すとすぐ消す。同時に出すのは 3 件まで（古いものから消す）。`warn` は警告色。TUI は下の固定部分の通知の行に 4 秒出す
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
- 内容: 会話の配列。各会話は `{ id, startedAt, updatedAt, title, pinned?, sessions: { claude?, codex? } }`
  - `sessions`: Agent の `session` event のたびに、その Agent の分を上書きする
  - `title`: その会話で最初の人間の入力（先頭 60 文字）
  - session も title も無い会話は保存しない。ピン止めした会話を先頭に、それ以外を新しい順に最大 20 件残す（ピン止めは枠に数えない）
  - `/rename` で名前を変えた会話は、以後の入力で名前を上書きしない。`/delete` した会話は feed も消す
- 起動時は新しい会話として始める。`clodex --resume` は最新の会話を続ける（各 Agent の最初の起動で、その会話の session を resume する）。前回の終了時に戻す作業があったとき、または `clodex serve` で起動したときは、前回の今の会話に戻る（下記の復旧）
- `/resume` は過去の会話を新しい順に番号付きで表示する。`/resume <番号>` でその会話に切り替える
  - 実行中のターンがある Agent がいれば拒否する（先に `/interrupt`）
  - 両 Agent をいったん止め、次に使うときに選んだ会話の session で起動する。選んだ会話に session が無い Agent は新しい session で始める
  - 切り替え前の会話も履歴に残る
- `/new` は両 Agent を止めて新しい会話を始める（前の会話は履歴に残る）。`/new <agent>` はその Agent だけを止め、今の会話の中で新しい session にする（その Agent の前の session は、その時点で会話から外して保存する）。作業中の Agent がいれば `/resume` と同じく拒否する
- コンテキストの管理（自動 compact 等）は各 CLI に任せる（§3.7）。手動で減らしたいときは `/compact`
- Claude は system prompt を session の最初に記録して resume 後も使う（`--system-prompt-snapshot` の既定）。役割（§13）を変えた後は `/new` で始め直すと確実に反映される
- 壊れたファイルは空の履歴として扱う（起動を妨げない）
- 書き込みのたびにファイルを読み直して今の会話を反映し（同じ project で複数の `clodex` を起動しても互いの会話を消さない）、一時ファイルに書いてから置き換える（書き込み途中で落ちても壊さない）
- Budget の chain と利用状況は保存しない（in-memory）。未配送分は下記の復旧のために保存する

Web UI の feed（§17）:

- 会話ごとに `event` / `output` を JSON Lines で追記する。保存先: 会話の履歴と同じ名前の `.feed` ディレクトリの `<会話 id>.jsonl`（例: `E--dev-Clodex-1a2b3c4d.feed/<id>.jsonl`）
- 起動時と会話の切り替え時に、今の会話の直近 1,000 件をメモリに読み込む（画面へ最初に送るのはそのうち直近 200 件。§17）。読み込んだ項目には新しい通し番号を振り直す
- 読み込み時に 2,000 行を超えていたら直近 1,000 件だけに書き直す（ファイルが増え続けないように）
- 会話の履歴（最大 20 件）から外れた会話の feed は、会話の切り替え時に削除する
- 壊れた行は読み飛ばす。読めないファイルは空の feed として扱い、保存に失敗しても作業は続ける

## Hub の再起動からの復旧（Phase 2）

GUI の入れ直しや `/exit`、異常終了で Hub が止まっても、受け付けた作業を失わないようにする。

保存（project ごと。会話の履歴と同じ名前の `.recovery.json`。例: `E--dev-Clodex-1a2b3c4d.recovery.json`）:

```text
{ current: 今の会話の id,
  conversations: { <会話 id>: { interrupted: [作業中だった Agent], queue: { claude: [...], codex: [...] } } } }
```

- `queue` は配送待ちのうち、人間の入力（本文・画像のパス）と formal message（message そのもの）だけ。`/compact`・model・effort の待ちは戻さない（設定は §9 で保存済み）
- `interrupted` は、ターンを実行中だった Agent。そのターンが処理していたものは配送済みなので `queue` には入らない
- 配送待ちが変わるたび・ターンが始まる・終わるたびに書き直す（異常終了でも直前の状態が残る）。戻す作業が 1 つも無い会話は書かない
- Hub の停止（`/exit`・GUI の終了）では、mailbox を閉じる前の状態のまま残す（閉じたことで空にしない）。Ctrl+D は配送が終わるのを待つので、戻すものは残らない

起動時の復旧:

- Hub は起動時に、開いたことのある project（`hub.json`）の `.recovery.json` を見て、戻す作業がある project を開く
- 戻す作業がある会話は runtime を作り（active にする）、次の順で mailbox に積む
  1. `interrupted` の Agent に、続きを頼む 1 行（Agent 向けなので英語: `[Clodex] Clodex restarted and your previous turn was interrupted. Continue the task you were working on.`）。その Agent に session が無ければ積まない
  2. `queue` を元の順に。人間の入力は新しい ID を振る（`/cancel` できる）。formal message は同じ message のまま、Budget の新しい chain として配送する（chain は保存していない）
- 戻した会話には `notice` を出す（例: `[CLODEX] 前回の終了から復旧: 中断 1 件、配送待ち 2 件`）。feed に `human` / `message` の event を出し直さない（前回の分が残っている）
- 今の会話は、戻す作業があったとき、または `clodex serve` のときは前回の `current` に戻す（履歴に無ければ新しい会話）。それ以外は今どおり新しい会話
- 履歴から消えた会話（`/delete` 済みなど）の分は捨てる
- 読めない・壊れたファイルは戻すものなしとして扱う（起動を妨げない）
- background process（§15）と実行中だった `!command` は戻さない

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

## v0.3 計画

dogfooding で出た要望を 4 段階で入れる。小さく確実なものから進め、構造に関わるもの（D）は設計を先に固める。CLI の挙動に依存するものは実測してから決める。

### A — 入力と会話の操作（Web UI / CLI）

コマンドの一覧は 1 か所の定数にまとめ、`/help`・入力の解釈・サジェストで共有する。

| 項目 | 内容 |
|---|---|
| スラッシュコマンドのサジェスト | Web UI: `/` で始まる入力中に候補（名前と説明）を出し、選ぶと補完する。CLI: readline の Tab 補完（入力中の表示は TUI 化（D）で行う） |
| `@` でファイル指定 | 行頭の `@claude` / `@codex` は送り先。それ以外の `@<path>`（project root からの相対パス）はファイルの参照。本文はそのまま送り、存在するパスを `Referenced files:` として末尾に足す（中身は埋め込まない。§3.5）。Web UI は `@` の後に候補を出す（`git ls-files` と未追跡の新規ファイル。.gitignore は除く） |
| 入力の強調表示 | Web UI: 先頭のコマンド、送り先の `@agent`、ファイルの `@path` に色を付けて、指定していることが分かるようにする |
| 利用枠のリセット時刻 | Web UI の Agent カードとシートに 5 時間枠と週の reset 時刻を短く出す（例: `5h 23% · 14:30`、`週 53% · 10/9 10:00`）。スマホの Agent ピルには出さない |
| Agent の設定ポップアップ | 権限・model・effort を、Agent ごとの 1 つのボタンから開くポップアップにまとめる。操作は対応するスラッシュコマンドを送るだけ |
| 新しい会話 | Web UI は会話一覧に「新しい会話」ボタンを 1 つ置く（`/new`）。Agent ごとの New（`/new <agent>`）は設定ポップアップの中に移し、「この Agent だけ session を始め直す」と説明する |
| 会話のリネーム・削除・ピン止め | `/rename <title>`（今の会話）、`/delete <番号>`、`/pin <番号>`（もう一度で解除）。ピン止めした会話は一覧の先頭に出し、最大 20 件の枠から外す。今の会話は削除できない。削除した会話の feed も消す。Web UI は会話一覧の項目のメニューから送る |
| 送信の取り消し・編集 | まだ配送していない人間の入力は取り消せる。Web UI は配送待ちの入力に「取り消し」「編集」を出す（編集は取り消して本文を入力欄に戻す）。CLI は `/cancel` で最後の配送待ちの入力を取り消す。配送済み（Agent が処理中）の入力は取り消せないので、`/interrupt` を使う。state に配送待ちの入力（ID・送り先・本文）を含める |
| `/interrupt` で Agent 間のやり取りを止める | Agent 指定なしの `/interrupt` は、実行中のターンと `!command` に加えて、配送待ちの formal message を破棄し、進行中の chain を閉じる（以後その chain の `send_message` は拒否）。人間の配送待ちの入力は残す（取り消しは上の操作で行う） |

### B — 成果物のプレビュー

- 会話で触れたファイルを一覧にする（新しい順、同じパスは 1 つ）。一覧は画面が feed から組み立てる（サーバーに状態を持たない。保存した feed から復元した会話でも出る）
  - 変更: tool event の `files`。Claude の Edit / Write / MultiEdit / NotebookEdit の `file_path`（`notebook_path`）、Codex の `fileChange` の `changes[].path`
  - 参照: formal message の `files` と `spec`
  - 画像: Agent の発言・最終応答と message の本文に書かれた画像のパス（png / jpg / jpeg / gif / webp）
- 画面上部の「成果物」から開く。選ぶと中身を表示する。テキストはそのまま（Markdown は §17 の簡易描画）、「差分」でその時点の `git diff HEAD`（未追跡なら中身）、画像はそのまま表示する。message の関連ファイルも選べる
- 会話の中でも画像を見せる（Web UI）。Agent の最終応答、formal message の本文、人間の入力に書かれた画像のパス（上の「画像」と同じ判定）を、本文の下にサムネイルとして並べる（同じパスは 1 つ）。`GET /api/file` で読み、読めない（範囲外・存在しない）ものは出さない。選ぶとビューアで開く。作業の途中経過（steps）と plan には出さない
  - サムネイルは小さく控えめにする（高さ 96px・幅 160px まで）。複数の画像があっても本文の下が埋まらないように。中身はビューアで見る
  - サムネイル・本文のパス・ビューアの画像の URL には、そのメッセージの時刻を `v` として付ける。同じパスの画像が書き換わったとき、ブラウザがページ内で前の画像を使い回さないように
  - 本文に書かれた画像のパス（サムネイルと同じ判定。インラインコードの中も含む。リンクの中は除く）も、クリック（キーボードは Enter）でビューアを開けるようにする。見た目は本文のリンクと同じ色（`--link`）と実線の下線、拡大のカーソル。本文にはファイル名だけを出し、フルパスは `title` に持たせる。サムネイルが読めなかったパスはリンクにしない。本文をパスとそれ以外に分ける処理は純関数にする
  - 画像のビューアは、テキストのシートとは別の全画面の表示にする（暗い背景に画像をウィンドウに収めて出す）。拡大縮小はホイール・ピンチ・ボタン（縮小・倍率・拡大・全体）、`+` / `-` / `0` のキー。ダブルクリック（タップ）で全体と等倍を切り替える。拡大中はドラッグで動かす。倍率は 0.1〜8 倍。上の帯にファイル名だけを小さく出し（フルパスは `title`）、元の画像を新しいタブで開くボタンと閉じるボタンを置く。Esc・背景のクリックで閉じる
  - 拡大縮小の計算（全体表示の倍率と位置、指した点を動かさない拡大）は純関数にする
- 本文の Markdown のインラインコードのうち、絶対パス（`C:\` / `C:/` / `~/` で始まるもの、`/` で始まり区切りが 2 つ以上あるもの。`/limits` のようなコマンドは含めない）は、ほかのインラインコードより小さく控えめな色にする（パスが本文より目立たないように）
- Agent が証跡として見せたい画像（スクリーンショット等）は、`~/.clodex/artifacts/<project 名>/` に保存して本文にフルパスを書くよう、役割の定型文で伝える（project の working tree を汚さない）
- API: `GET /api/file?path=` と `GET /api/diff?path=`（token 認証）。読めるのは project root と上の artifacts ディレクトリの中の通常ファイルだけ（`..` や symlink で外に出ない。実パスで確かめる）。大きさの上限はテキスト 2 MB、画像 10 MB

### C — 割り込みとマルチエージェント

実測: docs/spikes/steer-image-subagent.md

割り込み（steer）:

- Adapter の `steer(text)`: 実行中のターンに指示を足す。Claude は実行中に stdin へ user message をもう 1 行、Codex は `turn/steer`（`expectedTurnId` = 実行中の turn）。どちらも新しいターンにはならず、実行中の tool / command の区切りで取り込まれる。足せなかった（実行中でない、Codex の turn ID が未確定、`activeTurnNotSteerable` 等）ら false を返す
- 人間: `@claude! <text>` / `@codex! <text>`。その Agent が実行中なら steer し、そうでなければ（steer できなければ）通常の送信としてキューに積む。人間の入力の event に `steer: true` を付け、画面は「割り込み」と出す
- Agent: `send_message` の `interrupt: true`。宛先が**送信元からの message を処理中**のときだけ steer し（送信元が頼んだ作業の修正）、それ以外は通常どおりキューに積む。Budget の数え方は通常の message と同じ。Task envelope に `Interrupt: yes` を入れ、画面は「割り込み」と出す
- tool の説明と定型文で「完了を待つと手戻りになる修正のときだけ `interrupt: true` にする」と伝える

割り込みが届いた印（実測: docs/spikes/steer-ack.md）:

- 割り込みは実行中の tool の区切りまで取り込まれないため、送った後に Agent の応答がしばらく無い。届いたかどうかを、送った側の発言の印で見せる
- `steer(text, steerId)`: Coordinator が割り込みごとに ID を付ける。人間の割り込みは新しい UUID を使い、人間の入力の event に `steerId` を入れる。Agent の割り込みは message の ID を使う
- Adapter は、割り込みを取り込んだ時点で AgentEvent の `{ type: "steer_delivered", steerId }` を出す
  - Claude: 起動引数に `--replay-user-messages` を足す。割り込みの行に Adapter が作った UUID を `uuid` として付け、`steerId` と対応付けて覚える。`isReplay` の `user` の `uuid` が一致したら出す。区切りが無いまま終わったターンでは、割り込みが次のターンとして取り込まれ、そのときに出る
  - Codex: steer に成功したら、そのターンの未着の列の末尾に `steerId` を足す。自分の thread の `item/started`（`userMessage`）のうち、ターンの 2 つ目以降が来たら、列の先頭を出す。ターンが終わったら列を空にする
- 画面: 人間の割り込みの発言の「割り込み」の横に、届いたらチェックマークを出す（Web UI はアイコンで、`title` に「届いた」。TUI は `✓`）。届くまでは何も出さない。feed の再生でも同じ印になる（`steer_delivered` も Agent の event として feed に残る）
- Agent の割り込み（message）には印を付けない。message の event は steer できるか決まる前に出すため、通常の配送に回ったものと区別できない

マルチエージェント:

- 各 CLI の公式 subagent を使う（§3.7）。Clodex は Agent を増やさない
- 役割の定型文で、次の 2 つに subagent を使うよう伝える: 互いに独立して並列にできる作業、前提のコンテキストを持たない方がよい作業（レビュー、調査など）
- Claude: Agent tool（background を含む）。subagent の出力は本体の発言と区別する（§9）
- Codex: 公式の `multi_agent`（既定で有効）。subagent は別の thread で動くので、Adapter は自分の thread の通知だけを扱い、親の `subAgentActivity` を tool として出す（§9）

画像の貼り付け:

- Web UI で画像を貼り付け・選択すると `POST /api/upload`（token 認証、10 MB まで、png / jpeg / gif / webp）で `~/.clodex/uploads/<project 名>/` に保存し、入力欄に `@<保存先のフルパス>` を足す
- 人間の入力の `@<path>` のうち、画像のファイル（project・artifacts・uploads の中）は Agent に画像として渡す。Claude は user message の image block（base64）、Codex は `localImage`。本文の `Referenced files:` にも並べる
- 成果物の一覧（B）にも画像として出る（本文の画像のパスから）

### i18n — 画面の文言

- Web UI・CLI・通知の文言を `i18n/messages.ts` の文言カタログから引く。`en` がキーを決め、`ja` は `Record<MessageKey, string>` なのでキーの欠けは型エラーになる。`{name}` を params で置き換える（置き換える名前が両言語で同じことはテストで確かめる）
- 1 つのプロセスは同時に 1 つの言語で動く。起動時に §13 Language の言語を `setLanguage` し、`/language` で変えたら `setLanguage` し直す。CLI・通知は `t(key, params)` で引く
- Web UI は今の言語で画面を作り（`buildWebPage(language)`）、その言語の文言カタログを画面に埋め込む。言語が変われば画面の版も変わり、開いている画面は再読み込みする
- コードに文言を直接書かない。Agent 向けの指示（定型文・Task envelope・Budget のエラー）とプロトコルの値（コマンド名・状態名）は対象外

### D — 本体と UI の分離、並列の会話

構成:

```text
                 ┌──────────── Clodex Hub（常駐する 1 プロセス。ユーザーごと） ────────────┐
 Tauri GUI ──┐   │  Project A                                                               │
 (WebView2)  │   │   ├── 会話 1（active）── Coordinator ── Claude / Codex プロセス           │
 Web UI ─────┼──>│   ├── 会話 2（active, worktree A-2）── Coordinator ── Claude / Codex     │
 (スマホ PWA) │   │   └── 会話 3（保存のみ）                                                 │
 TUI / CLI ──┘   │  Project B …                                                             │
   HTTP + SSE    │  共有: 利用枠の監視（アカウント単位）、設定、保存                           │
                 └──────────────────────────────────────────────────────────────────────────┘
```

- **Hub**: Coordinator 群と保存を持つ常駐プロセス（`clodex serve`）。127.0.0.1 で HTTP + SSE を待ち受け、token で認証する（§17 と同じ）。UI は Hub の API だけを使う（Web 専用の経路を作らない、の延長）
- **会話の状態**: active（Coordinator と Agent プロセスが動いている）と、保存のみ（履歴と session ID だけ）。active にできる数は制限しない（1 つの会話で Agent プロセスが 2 つ動き利用枠も共有するが、どこまで並列に使うかは人が決める）
- **同じ project で並列に動かす会話**は、それぞれ別の git worktree で作業する（§16）。2 つ目以降の会話を active にするとき、Hub は worktree を作るか尋ねる（`git worktree add <project の隣>/<project 名>-<会話の短い ID> -b clodex/<会話の短い ID>`）。作成・削除・マージは人の操作。会話には worktree のパスとブランチを記録する
- **利用枠**: Claude / Codex の利用枠はアカウント単位なので、利用状況の監視（§14）と通知は Hub で 1 つにする。Budget の chain は会話ごと
- **API**（現在の 1 会話の API を会話 ID 付きに広げる）: `GET /api/projects`、`POST /api/projects`（フォルダを開く）、`GET /api/conversations?project=`、`POST /api/conversations`（新しい会話・worktree の指定）、`GET /events?conversation=`、`POST /api/input`（`conversation` と `line`）。ファイル系（`/api/file` 等）も会話（＝作業する場所）を指定する

UI:

- **Web UI**: 今の画面に project と会話の切り替えを足す。active な会話には作業中の印を出す。スマホは Web のまま、PWA（manifest とアイコン）にしてホーム画面に置けるようにする
- **Tauri GUI**（Windows）: Hub を起動・監視し、Web UI を WebView2 で表示する薄い殻。足すのはネイティブの機能だけ（フォルダの選択、通知、トレイ常駐）。画面そのものは Web UI と同じものを使う（作り分けない）
- **TUI**（CLI）: `clodex` を project で起動すると、Hub が動いていればそれにつなぎ、無ければ Hub を同じプロセスの中で起動する（今の使い方を変えない）。表示は今の readline 版を、入力中の候補表示などができる TUI に置き換える

段階:

1. **D1**: 1 つのプロセスの中で、1 つの project の複数の会話を active にできるようにする（Coordinator を会話ごとに作る。worktree の作成。Web UI の会話の切り替えと active の印）。PWA の manifest
2. **D2**: Hub として複数の project を扱う（`clodex serve`、project の API、CLI から Hub へつなぐ）
3. **D3**: Tauri GUI（`gui/` に Tauri のプロジェクト。Hub の起動、フォルダの選択、Web UI の表示）
4. **D4**: TUI

TUI に使うライブラリは D4 で決める。

D1 の詳細（1 つのプロセスの中の複数の会話）:

- 会話ごとに **ConversationRuntime**（Event Bus・Coordinator・MCP server・Agent・Event Log の file）を持つ。会話を初めて使うとき（入力・`/resume`）に作り、Clodex の終了まで残す（作業が終わった会話の Agent も止めない。戻ったときにすぐ使える）
- 人が見ている会話（**今の会話**）は 1 つ。terminal と Web UI は今の会話の event を表示し、入力・`/status`・`/interrupt`・`/cancel`・`/compact` 等は今の会話に対して行う
- `/resume <番号>` は今の会話を切り替えるだけで、前の会話の Agent は止めない（作業中なら続ける）。`/new` は新しい会話を今の会話にする
- 今の会話以外で Agent のターンが終わったら、`toast` で知らせる（例: `「設計の相談」の codex のターンが終わりました（completed）`。ログには入れない。§17）
- feed は会話ごとに保存する（今と同じ）。今の会話でない間の event も保存する
- **worktree**: `/new worktree` で、新しい会話用の worktree を作ってその会話の作業場所にする（`git worktree add <project の隣>/<project 名>-<会話の短い ID> -b clodex/<会話の短い ID>`）。会話の履歴に作業場所（`workDir`）とブランチを記録し、`/resume` で戻ったときもそこで Agent を起動する。worktree の削除・マージは人が git で行う
- 設定ファイルの `worktree.setup`（例: `"pnpm install"`）があれば、worktree を作って切り替えた直後に、その worktree で `!command` と同じように実行する。git が持たない依存関係（`node_modules` など）が無いと、worktree でテストが通らないため。出力は `!command` と同じに表示し、Ctrl+C や `/interrupt` で止められる。終わるのは待たない
- 同じ作業場所で別の会話の Agent が作業中のときに入力したら、`/new worktree` を勧める `toast` を出す（止めはしない）
- Web UI の会話の一覧に、各会話の状態（作業中・待機中・停止中）と worktree の印を出す
- 入力行は届いた順に処理する（会話の切り替えや worktree の作成を待ってから次の行へ）
- Web UI は PWA の manifest（`/manifest.webmanifest`）とアイコン（`/icon.svg`）を token なしで返す（秘密を含まない）
- iPhone のホーム画面用に `apple-touch-icon`（`/apple-touch-icon.png`。180px の PNG）も token なしで返す（iOS は SVG のアイコンを使わない）

アイコン:

- 図柄は橙の右向き記号・中央の橙の四角・青の左向き記号を黒の角丸の四角に置いたもの。元は `gui/icon.svg`（四隅は透明）。GUI・Web・PWA のアイコンはすべてここから作る
- GUI: `gui/` で `pnpm exec tauri icon icon.svg` を実行し、`gui/src-tauri/icons/` を作り直す（生成物は commit する）
- Web: favicon と manifest は `gui/icon.svg` と同じ SVG（`ICON_SVG`）。`apple-touch-icon` は iOS が角を丸めるため、背景を四隅まで黒で塗った `gui/icon-ios.svg` から 180px の PNG を作り、base64 の定数で持つ
- 背景色（manifest の `background_color`・`theme_color`）はアイコンの黒（`#000000`）に揃える

D2 の詳細（Hub として複数の project を扱う）。2 段に分ける:

- **D2a: 1 つのプロセスで複数の project**
  - 今の `main()` の project ごとの部分（設定・履歴・Agent の設定・Workspace・feed の保存・成果物のプレビュー・アップロード先）を **ProjectContext** として切り出す（`hub/project-context.ts`）。Hub は project root ごとに ProjectContext を持ち、開いた project を残す（会話と同じく、切り替えても Agent を止めない）
  - 人が見ている project（**今の project**）は 1 つ。terminal と Web UI は今の project の今の会話を表示する
  - `/project` で開いている project の一覧、`/project <path>` でその project を開いて今の project にする（path は resolveProjectRoot と同じ規則で解決する）。Web UI は上部に project の切り替えを出し、`/project <path>` を送る
  - 開いた project の一覧は `~/.clodex/hub.json` に保存し、次の起動で一覧に出す（開くのは選んだとき。ただし復旧する作業がある project は起動時に開く。§18）
  - **一覧の整理**: `/project pin <path>` でピン止めを切り替え、`/project remove <path>` で一覧から外す。path は一覧にあるものをそのまま指定する（フォルダが消えていても外せるよう、resolveProjectRoot では解決しない）。ピン止めは `hub.json` の `pinned` に保存する
    - 一覧はピン止めした project を先に、ほかを後に並べる（それぞれ開いた順）
    - 開いている project（今の project を含む）は外せない。外すと Agent を止めることになるため。外した project も `/project <path>` で開けば一覧に戻る
    - Web UI の project のセレクトは、ピン止めを「ピン止め」の optgroup にまとめ、最後に「一覧を編集…」を置く。選ぶとシートを開き、project ごとにパス・ピン止めのトグル（pin のアイコン。`aria-pressed`）・外すボタン（開いている project には出さない）を並べる
  - 環境変数 `CLODEX_HOME` があれば、Clodex 自身のデータ（`.clodex/` の設定・履歴・ログ・`hub.json` など）をユーザーのホームではなくそこに置く。Claude / Codex の設定や認証には関係しない。実 CLI の E2E は一時フォルダを指定し、ユーザーの一覧や設定を書き換えない
  - `clodex serve`: terminal の Shell を持たずに Hub と Web UI だけを動かす（`--web` 相当。project は Web UI から開く。起動時の project は省略可）
  - 言語・Web の token・ポートは Hub で 1 つ。project ごとの設定（`.clodex.json`）は ProjectContext ごとに読む
- **D2b: CLI から Hub へつなぐ**（D4 の TUI と一緒に行う）
  - Hub は起動時に `~/.clodex/hub.lock`（pid・port）を書く。`clodex` は lock の Hub が生きていれば、HTTP + SSE のクライアントとしてつなぐ。いなければ今どおり同じプロセスで動く


D3 の詳細（Tauri GUI。Windows）:

- `gui/` に Tauri v2 のプロジェクトを置く（Rust。`pnpm gui:dev` / `pnpm gui:build`。Tauri の CLI は devDependency の `@tauri-apps/cli`）
- GUI は Hub を探し、いなければ起動する。そのため `clodex serve` は起動時に `~/.clodex/hub.lock`（`{ pid, port, url }`）を書き、終了時に消す（D2b の lock を先に入れる）。GUI は lock の pid が生きていればその Hub を使い、いなければ `clodex serve` を子プロセスで起動して lock を待つ。GUI が起動した Hub は GUI の終了で止める（§10 終了）
- GUI は単体で動く: Node の実行ファイルと Clodex 本体（`dist` と本番用の `node_modules`）をアプリの resource に同梱し、Hub はそれで起動する。PATH の `clodex` や Node のインストールは要らない（Claude / Codex の CLI は今どおり PATH のものを使う）。開発中は `CLODEX_GUI_ENTRY`（と `CLODEX_GUI_NODE`）で同梱物の代わりに手元の `dist/index.js` を使える
  - 同梱物は `pnpm gui:dev` / `pnpm gui:build` の前に `gui/src-tauri/runtime/` に組み立てる（git の管理外）。`dist` は `import.meta.resolve` で `marked` のファイルを読むため、1 ファイルへの bundle はせず、`node_modules` ごと入れる
  - 既に動いている Hub（CLI の `clodex serve` 等）があれば、版が違ってもそれを使う
- ウィンドウは Hub の Web UI（`<url>/?token=<~/.clodex/web-token>`）を WebView2 で開くだけ。画面は Web UI と同じものを使う
- ネイティブで足すのはフォルダの選択だけ（D3 の範囲）: Web UI の「開く」は、Tauri の中（`window.__TAURI__` がある）ならフォルダ選択のダイアログで選んだパスを `/project <path>` として送る。ブラウザでは今どおりパスを入力する。Tauri の IPC は Hub の URL（127.0.0.1）からだけ許す（capability の remote の設定）

通知とトレイ常駐（D3 の後）:

- **トレイ常駐**: ウィンドウを閉じても終了せず、ウィンドウを隠してトレイに残る（Hub と Agent は動き続ける）。トレイのアイコンを左クリックするとウィンドウを出す。メニューは「開く」「終了」で、「終了」で GUI を終える（GUI が起動した Hub は今どおり止める）。GUI をもう一度起動したら、新しいウィンドウを作らず既存のウィンドウを出す（single instance）
- **通知**: Tauri の中の Web UI が、ウィンドウが見えていないかフォーカスが無いときに、Windows の通知を出す（`tauri-plugin-notification`）。ブラウザの Web UI では出さない
  - 今の会話の作業が終わったとき: 作業中（どれかの Agent が busy か配送待ちがある）から、どの Agent も busy でなく配送待ちも無い状態になったとき。本文は最後に終わったターンの Agent と最終応答の 1 行目
  - `notice`（利用枠など）・`toast`（ほかの会話の完了など）と `error`
  - 画面を開いたときや会話を切り替えたときの feed の読み込み（再生）では出さない
  - 音は Windows の既定の通知音（plugin は `sound` を指定しないと無音にする）
- **スマホへの通知（Web Push）**: 上の通知のうち、今の会話の作業が終わったとき（Agent の返答）と Agent の質問（`ask_user`）だけを、登録した端末（ホーム画面に追加した PWA。iOS 16.4 以降）に Web Push で届ける。画面を開いていなくても届く
  - 通知を出すかは Hub が決める。Hub は feed を購読し、上の通知と同じ関数（`updateDesktopNotify`）で通知を作り、種類（`kind`）が `finished` と `question` のものだけを送る。会話の切り替えなどの再生は feed の購読に流れないので、通知しない
  - 送り先から外す: その端末の画面が見えている間（下の `visible`）は送らない。iOS は Push を受けて通知を出さないと購読を取り消すことがあるので、Service Worker では間引かず、Hub が送る前に間引く
  - 鍵: VAPID の鍵は初回に作り `~/.clodex/push/vapid.json` に置く（subject は `https://github.com/HiraG-62/Clodex`）。購読は `~/.clodex/push/subscriptions.json`（`{ id, endpoint, keys }[]`。`id` は endpoint の SHA-256 の先頭 16 文字）。送信が 404 / 410 なら購読を消す
  - API（token で認証）: `GET /api/push/key`（公開鍵）、`POST /api/push/subscribe`（購読。`id` を返す）、`POST /api/push/unsubscribe`（`{ id }`）、`POST /api/push/visibility`（`{ id, visible }`）。Service Worker の `/sw.js` は秘密を含まないので token なしで返す
  - 見えているか: 購読した端末の画面は `/events?push=<id>&visible=<0|1>` でつなぎ、`visibilitychange` で `/api/push/visibility` を送る。Hub は id ごとに、つながっていて見えている接続があれば送らない。接続が切れたら見えていない扱い
  - Service Worker: `push` で通知を出す（タイトルと本文）。通知を押したら開いている画面を前に出し、無ければ `/` を開く
  - 設定画面の「端末」の節の「通知」: `off` / `on` のトグル（`on` で権限を求めて購読、`off` で解除）。Push を使えない画面（`PushManager` が無い。iOS の Safari でホーム画面に追加していないときなど）と GUI の中の画面では出さない。権限が拒否されたり失敗したりしたら toast を出して `off` のままにする
- Tauri のメニューの文言は GUI（Rust）の定数に置く（Web UI の文言カタログの外）
- ウィンドウの位置・大きさ・最大化の状態を覚え、次に起動したときに戻す（`tauri-plugin-window-state`）。トレイの「終了」・ウィンドウを隠したときに保存する。保存した位置の画面が無くなっていれば、見える位置に戻す

GUI の自動更新（D3 の後）:

- インストーラーを手で入れ直さずに、GUI の中で新しい版を取得して入れ替える。配布も兼ねて、更新の元は GitHub Releases にする（Tauri 公式の `tauri-plugin-updater`）
- 版の元は `package.json` の `version` だけにする。`tauri.conf.json` の `version` は `../../package.json` を指す。tag は `v<version>`
- 公開: GitHub Actions（`.github/workflows/release.yml`、Windows の runner）が `pnpm typecheck`・`pnpm test`（失敗したら公開しない）・`pnpm build` と同梱物の組み立ての後に `tauri-apps/tauri-action` で build し、NSIS のインストーラー・署名（`.sig`）・`latest.json` を Release に上げる
  - 本番: tag `v*` の push。tag と `package.json` の版が違えば失敗させる
  - dev: master への push（`docs/**` と `*.md` だけの変更は除く）。版は `package.json` の版のパッチを 1 つ上げて `-dev.<N>` を付けたもの（`0.1.0` → `0.1.1-dev.3`）を CI が `package.json` に書いてから build する。N は `package.json` の版を最後に変えたコミットより後の、build の対象になるコミット（`docs/**` と `*.md` だけの変更を除く）の数。本番を出すたびに 1 から数え直す（版上げのコミット自体の build は `dev.0`）。tag `v<その版>` は Release の作成で付く。人は版も tag も触らない
  - dev の build は同時に 1 つだけ動かし、新しい push が来たら古い build を止める（古い build が後から `latest.json` を戻さないように）
  - dev の build の後、dev の prerelease は新しい 3 件だけ残し、古いものは tag ごと消す
  - 版を決める処理は `scripts/release-version.mjs`（テスト付き）
- 署名: 鍵は `tauri signer generate` で作る。公開鍵は `tauri.conf.json` の `plugins.updater.pubkey`、秘密鍵とパスワードは GitHub の Secret（`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）にだけ置く。更新用の成果物（`createUpdaterArtifacts`）は CI 用の設定（`gui/src-tauri/tauri.release.conf.json`）でだけ有効にし、手元の `pnpm gui:build` は秘密鍵なしで今どおり動かす
- チャンネル: 公開用の `stable` と自分用の `dev`。`~/.clodex/config.json` の `updateChannel` で選ぶ（既定 `stable`。読めない・知らない値も `stable`）
  - `stable` の取得先: `https://github.com/HiraG-62/Clodex/releases/latest/download/latest.json`（GitHub の latest は prerelease を含まない）
  - `dev` の取得先: `https://github.com/HiraG-62/Clodex/releases/download/dev/latest.json`
  - 版に `-` を含むもの（dev の build）は prerelease として公開する。それ以外は通常の Release
  - workflow は、どの Release でも `latest.json` を固定の prerelease `dev`（無ければ作る）に上書きで上げる。`dev` のチャンネルは正式版も含めた最新の版を受け取る
  - 版の順序は semver（`0.1.0 < 0.1.1-dev.1 < 0.1.1-dev.2 < 0.1.1`）。本番を出したら、その後の dev は自動で次のパッチ（`0.1.2-dev.1` から）になる
- 確認と入れ替えは GUI（Rust）が行う
  - 起動時に 1 回、ウィンドウを出した後にバックグラウンドで確認する。新しい版が無いか、確認に失敗したら何も出さない
  - トレイのメニューに「更新を確認」を足す。新しい版が無ければ「最新版」、失敗したらエラーをダイアログで出す
  - 新しい版があれば、ダイアログで「Clodex <version> に更新しますか？作業中のターンは止まります」と聞く（「更新」「後で」）
- 入れ替え: 「更新」でダウンロードし署名を検証する。GUI が起動した Hub を止めてから（同梱の `node.exe` を使っているため。updater はインストーラーを起動するとプロセスを即座に終えるので、終了時の処理には頼らない）インストーラーを passive で起動し、入れ替え後に GUI を起動し直す。止めた Hub の会話は §Hub の再起動からの復旧 で戻る
- GUI が起動していない Hub（CLI の `clodex serve`）は止めない。その Hub は入れ替えの対象外
- Web UI の設定からの更新: スマホ等の Web UI からも、GUI に確認と入れ替えをさせる。Hub が中継する
  - GUI の中の Web UI（`window.__TAURI__` がある画面）は `/events?gui=<GUI の版>`（`core:app:allow-version` で取得）でつなぐ。Hub はこの接続を GUI として覚える（複数あれば最後のもの。切れたら外す）
  - Hub は GUI の有無と更新の状態を feed の `{ type: "gui", gui: { version, update } | null }` で全画面に送る（接続時と変わったとき）。`update` は `checking` / `latest` / `available`（`version`）/ `installing` / `error`（`message`）。GUI がつながっていなければ状態は消す
  - 設定画面の「Clodex」の節に、GUI の版と「更新を確認」を出す。GUI がつながっていないときはこの項目を出さない。状態は「確認中…」「最新版」「<version> あり」と「更新」ボタン、「更新中…」、「失敗: <message>」。「更新」は確認（「Clodex <version> に更新しますか？作業中のターンは止まります」）の後に送る
  - 画面は `POST /api/gui/update`（`{ action: "check" | "install" }`）を送る。Hub は状態を `checking` / `installing` にし、GUI の接続へ `{ type: "gui_command", action }` を送る。GUI が無ければ 409
  - GUI の画面は Tauri command（`check_update` / `install_update`）を呼び、結果を `POST /api/gui/status` で Hub に返す。`install_update` はダイアログを出さずに入れ替える（上の入れ替えと同じく Hub を止めてからインストーラーを起動する）。入れ替え後に GUI と Hub が起動し直し、各画面は再接続で新しい版の画面を読み込む
  - Tauri 2.11.1 以降は、外部 URL の画面（Hub の `http://127.0.0.1`）から app の command を呼ぶには ACL の許可が要る。`build.rs` の `AppManifest` に command を並べ、capability `main` で `allow-check-update` / `allow-install-update` を許可する（`check_update` は新しい版の版か `null` を返す）


D4 の詳細（TUI。D2b と一緒に行う）:

- TUI は Ink（React で端末の画面を組む）で作る。`clodex` を terminal（TTY）で起動したときの既定の画面にする。stdin が TTY でないとき（パイプ入力）は今の行ごとの処理のまま
- TUI は **feed のクライアント**として作る。Web UI と同じく、feed の項目（`event` / `output` / `state` / `reset`）を受け取り、1 行の入力を送るだけ。つなぎ先は 2 通りで、TUI は違いを知らない:
  - **Hub につなぐ（D2b）**: `~/.clodex/hub.lock` の Hub が生きていれば、HTTP + SSE（`/events`・`/api/input`・`/api/files`、token は `~/.clodex/web-token`）でつなぎ、起動した場所の project を `/project <cwd>` で開く。TUI を閉じても Hub は止めない
  - **同じプロセスで動かす**: Hub がいなければ今どおり同じプロセスで Hub を動かし、feed と入力を直接つなぐ
- **代替画面で動かす**（Claude Code の全画面表示と同じ作り）: 起動時に代替画面へ入り（Ink の `alternateScreen`）、マウスのイベントを受け取る（`ESC[?1000h` と SGR 形式の `ESC[?1006h`）。Windows の Node は raw mode でマウスの入力を捨てるので、Ink が raw mode に入った後に標準入力のコンソールモードへ `ENABLE_VIRTUAL_TERMINAL_INPUT`（0x200）を足す。ConPTY は VT 入力モードの前に出したマウスの設定を端末へ渡さないので、マウスの設定はその後に出す（`docs/spikes/windows-mouse.md`）。足すのは起動を待たせないよう非同期で行い、失敗したらマウスの設定は出さず通知だけにする（ホイール以外は使える）。Ink 8 は SGR マウスのシーケンスを `useInput` に渡さず捨てるので、stdin と Ink の間に中継の stream を置き、SGR マウスのシーケンスだけを抜き出して TUI に渡し、残りを Ink に渡す終了時（Ctrl+D・例外・シグナルを含む）は必ずマウスを戻して代替画面から出る。起動前の画面はそのまま残る。会話は端末の履歴に残らない（読み返すのは Web UI か `/resume`）
- 画面の構成: 上がログの表示領域、下に固定で状態の行・候補・入力欄・下の 1 行。ログの表示領域の高さは、端末の行数から下の固定部分の行数を引いたもの
- ログは TUI が行として持ち、表示領域に入る行だけを描く（Ink の `Static` は使わない）。ログの項目は人の入力・ターン（作業中のものも末尾に含む）・message・通知・エラー・コマンドの出力。各項目を端末の幅で折り返した行の配列にし（全角は 2 桁）、項目と幅ごとに覚えておく。幅が変わったら折り返し直す
- スクロール: TUI が持つ。位置は「一番下から何行上か」で持ち、0 なら一番下に付いていく
  - マウスのホイール 1 刻みで 3 行。PageUp / PageDown で表示領域の高さ − 1 行。Ctrl+End で一番下へ。送信したときも一番下へ戻す
  - 読み返している間（位置が 0 でない）に行が増えても、見ている内容を動かさない（増えた行数ぶん位置を足す）。その間は表示領域の右下に「↓ 新着」を出す
  - 位置は 0 から「全行数 − 表示領域の高さ」（0 未満なら 0）の範囲に収める
  - 文字の選択とコピーは Windows Terminal の Shift+ドラッグで行う。クリックなどホイール以外のマウスのイベントは無視する。端末の検索（Ctrl+Shift+F）は使えない
- `Ctrl+O` はすべてのターン（過去のものを含む）の作業の一覧を開くかどうかを切り替える
- デザイン（配色は Web UI と同じ。Claude は橙、Codex は青）:
  - **状態の行**（枠なし・目立たせない）: 入力欄の下に Agent ごとに 1 行。色を付けるのは Agent 名だけで、ほかは薄い色: 状態（作業中はスピナーと経過時間）· model · effort · 権限（`full` だけ警告色）· 利用枠（5 時間・週・ペース）。作業中の Agent だけ、その下に今の作業を 1 行。project と（worktree なら）ブランチは下の 1 行に出す
  - **見出しの行の背景**: 発言の切り替わりがわかるように、人の入力・ターン・message の見出しの行（1 行目）だけ、ログの表示領域の幅いっぱいに薄い背景色を付ける。色は発言した側（message は送信元）の色を暗い背景に 20% だけ混ぜたもの: 人 `#323234`（灰）・Claude `#3c3025`（橙）・Codex `#272e39`（青）。暗い配色の端末を前提にする
  - **ターン**: Agent の色の縦線でまとめ、見出し（Agent・状態・経過時間）、方針（薄い色）、`▸ 作業 N 件`（開いているときは一覧）、最終応答
  - **Markdown**: `marked` の解析結果（Web UI と同じ。§17）から描く。見出し・太字・インラインコード・箇条書き・番号付きリスト（入れ子は字下げ）・コードブロック（枠）・引用（行頭に薄い `│`）・表（列幅をそろえた罫線つきの表。端末の幅を超えるときは各行を折り返す）・区切り線（幅いっぱいの薄い `─`）。斜体と取り消し線は端末の装飾（italic / strikethrough）。長い行は端末の幅で折り返す（切らない）。本文には背景色を使わない（背景を付けるのは見出しの行だけ）。インラインコード（ファイルパスなど）とコードブロックの中身は落ち着いた緑（Agent の橙・青と同じ明るさと彩度）。見出しは太字だけ（Codex の青と紛れないように色を付けない）。リンクは下線
  - **message**: 太い縦線のカード。送信元 → 宛先、種類（色付き）、taskId、本文。通知は黄色、エラーは赤
  - **入力欄**（角の丸い枠）: 空のときは 1 行で、カーソルの後ろに薄い文字で「メッセージ」と出す（見出しの行は置かない）。行が増えると広がる。←→・Home・End でカーソルを動かす。↑↓ は候補が出ていなければ前後の行へ動かす（列はできるだけ保ち、短い行では行末。最初の行の ↑ と最後の行の ↓ は何もしない）。候補は入力欄の上に枠付きで出す
  - **下の 1 行**: project（worktree ならブランチ）、送信待ちの件数と使えるキー（Enter 送信 · Ctrl+J 改行 · PgUp/PgDn スクロール · Ctrl+O 作業 · Ctrl+C 中断 · Ctrl+D 終了）
- 入力: Enter で送信、改行は Ctrl+J。`/` と `@` の候補は Web UI と同じ `createInputAssist`（引数の候補を含む）を使い、↑↓ と Tab で選ぶ。Ctrl+C は今の会話の実行中のターンを止める（無ければ終了の案内）、Ctrl+D は終了

### E — 役割の編集と画面の改善

役割:

- Clodex は役割の文章を作らない（書くのは人）。表示と編集の手段だけを持つ
- `/role` で両 Agent の役割、`/role <agent>` でその Agent の役割を表示し、`/role <agent> <text>` で project の `.clodex.json` の `roles` を書き換える（他のキーは残す。ファイルが無ければ作る。書き込みは一時ファイル経由）。役割は 1 行（改行は空白にする）。反映は次に始める session から（system prompt に入るため）。書き換えたら `/new <agent>` で始め直すよう案内する
- Web UI: 役割の本文をパネルに常に出さない。Agent の見出しに役割のアイコン（ペン）を置き、押すと Agent の設定のポップアップを開く。役割の表示と編集（textarea と保存。保存は `/role <agent> <text>` を送るだけ）はその先頭に置く

Agent の設定（model・effort・権限）:

- 表示: Agent の見出しの下に小さなチップを 1 行で並べる（model・effort・権限）。権限が `full` のときだけ警告色。押すと設定のポップアップを開く。利用枠のゲージはその下
- model はリストから選ぶ。一覧は CLI から取得し、固定リストは持たない（docs/spikes/model-list.md）
  - Claude: 短命の `claude -p --input-format stream-json ...` に `control_request` の `initialize` を送り、応答の `models` を使う。値は `value`、表示名は `displayName`。`default` は `displayName` に版が無いので `description` の ` · ` より前を足して `Default (Opus 5.5)` とする
  - Codex: 短命の `codex app-server` で `initialize` → `model/list`（`nextCursor` を最後までたどる）。値は `model`、表示名は `displayName`。`hidden` は除く
  - 取得は Clodex の起動時に 1 回、Agent の Lazy Start を待たずにバックグラウンドで行う（ターンを送らないので利用枠を消費しない）。同じプロセスで利用状況も取得する（§利用枠の可視化と通知）。取得できるまで・失敗したときは空の一覧（「その他（入力）」だけ）。一覧は project によらないので Hub で共有する
  - リストは表示名を出し、選ぶと値を `/model <agent> <value>` で送る。リストの最後に「その他（入力）」を置き、自由に入力もできる
- 一覧は state に Agent ごとに `{ value, label }[]` で入れる。Claude は `resolvedModel` も持ち、今の model の表示（チップ・状態の行・`/status`）は値か `resolvedModel` が一致する項目の表示名にする（例: `claude-opus-5-5` → `Opus 5.5`）。一致しなければ値のまま
- スラッシュコマンドの `/model` の引数の候補は値を出し、表示名を説明として添える

作業中の表示:

- ログとは別の開閉できる「作業中」パネルに、作業中のターンの発言（方針と、作業の途中の say）を時系列に並べる（PC は右のサイドタブ、スマホは下から開くシート）。ログのターンは方針と完了報告だけを出して作業を畳むので、作業の流れはこのパネルで追う。tool は出さない
  - 発言のターン（Agent）が前の発言と変わるところに見出し（Agent・方針の 1 行目・経過時間）を挟む。両 Agent が別の作業をしていても、どの作業の発言か分かるようにする。まだ発言の無いターンは開始の位置に見出しだけを出す。見出しを押すとログのそのターンへ移動する
  - 発言は Markdown で描く。パネルの一番下を見ていたら、新しい発言に合わせて下へスクロールする
  - 作業中の数をボタンに出す。作業中のターンが無くなったらボタンごと隠す

入力:

- スラッシュコマンドは引数まで候補を出す。コマンドごとに引数の候補を定義する（Agent 名、権限、effort の値、model の一覧、`/resume`・`/delete`・`/pin` の会話の番号と名前、`/project` の project、`/new` の `worktree` と Agent 名、`/cancel` の送信待ちの ID）。候補の元は state
- 入力欄が大きくなるとき: ログの一番下にいたら、入力欄が広がってもログの最後が見えるようにスクロールを合わせる。読み返している最中なら動かさない
- 入力欄の強調表示の層は textarea と同じ大きさに固定する（textarea の外まで広がって、入力欄の中に余白が増えないように）
- 先頭が `!` の入力（`!command`）は、Agent へのメッセージではないと分かる「コマンド入力」の見た目にする。先頭の `!` を消すと元に戻る。判定は 1 つの純関数（先頭が `!` か）にして Web UI と TUI で共有する
  - Web UI: 入力欄の枠と左端の印をコードの緑（インラインコードと同じ色）にし、本文を等幅フォントにする。入力欄の上に小さなラベル「コマンド」を出す。送り先の切り替えは使わないので薄くして無効にする。送信ボタンの文言は「実行」
  - TUI: 入力欄の枠をコードの緑にし、枠の上辺に「コマンド」のラベルを出す

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
