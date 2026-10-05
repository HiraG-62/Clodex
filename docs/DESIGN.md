# Windows Native AI Development Shell — Design Document

> Claude Code × Codex  
> Small Core / Long-Term Architecture  
> Status: Initial Design / v0.1-first

## 1. このプロジェクトは何か

Windows ネイティブの既存開発環境を維持したまま、**Claude Code と Codex CLI を対等な開発エージェントとして協調させるための薄い Development Shell** を作る。

目的は巨大なマルチエージェント基盤を自作することではない。

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

## 3.1 Single Agent First

通常のタスクは **1 Agent で完結させる**。

```text
Task
 │
 ▼
Primary Agent
 │
 ├── 十分に解決可能 ──────────> DONE
 │
 └── 別 Agent の価値が高い
             │
             ▼
          Delegate
```

「Claude と Codex がいるから毎回両方に聞く」はしない。

---

## 3.2 Lazy Delegation

他 Agent は必要になった時だけ呼び出す。

委譲価値が高い例:

- Architecture decision の不確実性が高い
- Security-sensitive な変更
- 難しいバグ
- 一度調査しても原因不明
- 大規模変更
- 独立レビューに価値がある
- Codex CLI 自身の統合
- Windows PTY / Process 制御
- MCP protocol 設計

原則委譲しない例:

- trivial edit
- formatting
- lint
- 単純な type error
- 明確な小規模実装
- Primary Agent が高い確信度で処理できるもの

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

---

# 8. Input UX

将来的な入力形式。

| Input | Action |
|---|---|
| 普通のテキスト | Primary Agent |
| `@claude ...` | Claude へ直接送信 |
| `@codex ...` | Codex へ直接送信 |
| `@all ...` | 両方へ送信 |
| `!command` | foreground shell command |
| `!& command` | background process |
| `/command` | Shell internal command |

`@all` は高コスト操作なので警告対象とする。

Internal command 候補:

```text
/status
/agents
/tasks
/messages
/budget
/worktree
/processes
/help
/exit
```

---

# 9. Agent Adapter

Claude Code / Codex 固有の process/session 制御を Adapter に閉じ込める。

```ts
interface AgentAdapter {
  readonly id: "claude" | "codex";
  readonly capabilities: AgentCapabilities;

  start(task: AgentTask): Promise<AgentSession>;

  resume(
    sessionId: string,
    message: AgentInput,
  ): Promise<void>;

  interrupt(
    sessionId: string,
  ): Promise<void>;

  getStatus(
    sessionId: string,
  ): Promise<AgentStatus>;

  subscribe(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): () => void;
}
```

CLI ごとに capability が異なる場合は明示する。

例:

```ts
interface AgentCapabilities {
  interactive: boolean;
  resumable: boolean;
  interruptible: boolean;
  mcp: boolean;
  structuredOutput: boolean;
}
```

Unsupported operation は Coordinator が明示的に拒否する。

---

# 10. CLI Lifecycle

最初から方式を決め打ちしない。

Phase 0 で以下を実測する。

### Option A — Interactive PTY

```text
Coordinator
    │
    ▼
ConPTY / node-pty
    │
    ▼
Claude / Codex interactive CLI
```

利点:

- 実際の CLI UX に近い
- 長寿命 Session を扱いやすい
- Observable

懸念:

- ANSI parsing
- resize
- Ctrl+C
- prompt detection
- Windows ConPTY quirks

### Option B — Non-interactive + Resume

```text
Coordinator
    │
    ├── CLI invocation
    │
    └── session resume
```

利点:

- Process lifecycle が単純

懸念:

- 各 CLI の resume capability に依存
- Session continuation の挙動差

実測結果をもとに Adapter を確定する。

---

# 11. Agent Communication

Raw terminal output を Agent 間通信として扱わない。

```text
Execution Output
      ≠
Agent Message
```

Formal message channel を別に持つ。

想定 Message Types:

```text
QUESTION
REVIEW_REQUEST
DELEGATE
RESULT
ISSUE
ACK
```

例:

```json
{
  "id": "msg_01",
  "type": "REVIEW_REQUEST",
  "from": "claude",
  "to": "codex",
  "taskId": "AUTH-142",
  "objective": "refresh token処理のrace conditionを確認",
  "repository": "C:\\dev\\my-app",
  "commit": "a82f39c",
  "files": [
    "src/auth/refresh.ts"
  ]
}
```

返却:

```json
{
  "id": "msg_02",
  "type": "RESULT",
  "replyTo": "msg_01",
  "from": "codex",
  "to": "claude",
  "taskId": "AUTH-142",
  "status": "changes_requested",
  "issues": [
    {
      "file": "src/auth/refresh.ts",
      "line": 142,
      "severity": "high",
      "summary": "同時refreshでtoken rotationが競合する"
    }
  ]
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

---

# 13. Context Resolver

Agent B に渡す Context は Task envelope を基本とする。

```text
Task: AUTH-142

Objective:
refresh token の race condition をレビュー

Repository:
C:\dev\my-app

Commit:
a82f39c

Relevant files:
- src/auth/refresh.ts

Requested output:
- severity
- file / line
- concise summary
```

Agent B は必要に応じて Repository を読む。

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

---

# 14. Budget Manager

初期設定例:

```yaml
budget:
  mode: economy

  maxDelegationsPerTask: 2
  maxReviewRounds: 2
  maxMessageHops: 4
  maxDelegationDepth: 2

context:
  strategy: lazy
  includeConversationHistory: false
  preferGitDiff: true
  preferFileReference: true

delegation:
  strategy: single-agent-first
```

将来の `/budget` イメージ:

```text
Session Budget

Claude
  Calls           12
  Delegations      2
  Context         MEDIUM

Codex
  Calls            3
  Delegations      0
  Context          LOW

Cross-Agent
  Messages         7
  Review rounds    1 / 2

Mode
  ● Economy
```

Agent 同士が無限に会話しないよう hard limit を持つ。

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

---

# 18. Persistence

v0.1:

```text
In-memory state
+
simple event log
```

から開始してよい。

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

- [ ] TypeScript / Node.js project
- [ ] Windows native execution
- [ ] Project root detection
- [ ] Claude Code CLI launch
- [ ] Codex CLI launch
- [ ] Real-time observable output
- [ ] Formal Claude → Codex message
- [ ] Formal Codex → Claude message
- [ ] Target Agent wake / resume
- [ ] Message logging
- [ ] Human interrupt
- [ ] Existing subscription authentication
- [ ] Minimal hard budget limits

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
│   ├── message-router.ts
│   ├── task-manager.ts
│   └── budget-manager.ts
│
├── agents/
│   ├── agent-adapter.ts
│   ├── claude-adapter.ts
│   └── codex-adapter.ts
│
├── process/
│   └── pty-process.ts
│
├── protocol/
│   ├── messages.ts
│   └── schemas.ts
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

3. Minimal Windows PTY wrapper（Spike C）

4. Claude Code lifecycle spike（Spike A）

5. Codex CLI lifecycle spike（Spike B）

6. Authentication spike（Spike E）

7. MCP spike（Spike D）

8. Observed capabilities を元に AgentAdapter を確定

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

上限値は §14 の `budget` 設定を使う。

`ACK → ACK → ACK` のような無意味な往復を発生させない。

Message Router は同一 message ID の重複処理を避けられる構造にする。

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
Single Agent First
       +
Lazy Delegation
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
