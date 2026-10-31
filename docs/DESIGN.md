# Windows Native AI Development Shell — Design Document

> Claude Code × Codex  
> Small Core / Long-Term Architecture  
> Status: v0.3 実装済み  
> v0.1 当時の計画（範囲・構成・実装順・初期の役割分担・最初の指示）: [docs/history/v0.1-plan.md](history/v0.1-plan.md)

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

Clodex が行うのは、見えるようにすることと、hard limit で止めることだけ。「この Agent を今呼ぶ価値があるか」の判断は Coordinator ではなく人と Agent が行う（§3.9 Deterministic Coordinator）。

- 見えるようにする: 両 Agent の利用枠（5 時間・週）とコンテキストの大きさ（§14 利用枠の可視化と通知、§17）
- 止める: Agent 同士のやり取りの chain ごとの上限（message 数・レビュー回数・委譲回数・深さ。§14）
- 利用枠の上限に達した Agent は、リセットまで送らずに待つ（§14）

人が送っていないのに Clodex が Agent のターンを起こす経路は、次に限る（増やすときはここに足す）。

| 経路 | 回数 | 節 |
|---|---|---|
| 作業を頼む message のターンが失敗したときの再送 | 1 回だけ | §11 配送ルール |
| 再送も失敗したとき、送信元に自分で進めるよう伝える | 依頼ごとに 1 回 | §11 配送ルール |
| Agent が `send_message` を使わずに返した依頼の結果を、依頼元へ届ける（自動 `RESULT` / `ANSWER`） | 依頼ごとに 1 回 | §11 配送ルール |
| 利用枠のリセット後に、上限で止まっていた作業の続きを頼む | 止まるごとに 1 回 | §14 |
| Hub の再起動後に、中断したターンの続きを頼む | 再起動ごとに 1 回 | §18 |

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
 Terminal（readline）   TUI（ink）   Web UI / GUI（Tauri）
         │                  │ HTTP + SSE       │
         └──────────────────┼──────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────┐
│ Hub（1 プロセス。hub.lock・Web server・開いた project の一覧） │
│                                                          │
│  ProjectContext（project ごと。設定・会話の履歴・feed・復旧）    │
│   └── Workspace（会話ごとの runtime を管理）                 │
│        └── ConversationRuntime（会話ごと）                  │
│             ├── Coordinator                              │
│             │    ├── AgentMailbox（Agent ごとの配送待ち）     │
│             │    ├── Budget Manager                      │
│             │    └── Context Resolver                    │
│             ├── Event Bus → Event Log・feed・UI           │
│             └── MCP server（send_message など）            │
│  Process Manager（!command）  Sandbox                     │
└──────────────────┬───────────────────┬───────────────────┘
                   ▼                   ▼
          ┌────────────────┐  ┌────────────────┐
          │ Claude Adapter │  │ Codex Adapter  │
          └───────┬────────┘  └───────┬────────┘
                  ▼                   ▼
           Claude Code CLI        Codex CLI
                  └─────────┬─────────┘
                            ▼
                Git / Files / Artifacts
```

- 依存の向きは Coordinator → AgentAdapter interface ← 各 Adapter。Coordinator は Claude / Codex 固有の実装に依存しない
- Hub・ProjectContext・ConversationRuntime の詳細は §28 D

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

Hub が動いているとき（§28 D2b）は、起動オプションを Hub へのコマンドに変えて送る: `--project` は `/project <絶対パス>`（無ければ起動した場所）、`--primary` は `/primary <agent>`、`--claude-model` / `--codex-model` は `/model <agent> <model>`。`--resume` と `--web` は Hub の状態をそのまま使うので変えず、無視したことを 1 行出す（`Hub 起動中のため無視: --resume`）

---

# 8. Input UX

| Input | Action | v0.1 |
|---|---|---|
| 普通のテキスト | Primary Agent へ送信 | ✓ |
| `@claude ...` | Claude へ直接送信 | ✓ |
| `@codex ...` | Codex へ直接送信 | ✓ |
| `@claude! ...` / `@codex! ...` | その Agent の実行中のターンに指示を足す（steer）。実行中でなければ通常の送信（§28 v0.3 C） | ✓ |
| `@all ...` / `@all! ...` | 両方の Agent へ同じ本文を送る（`@all!` はそれぞれに steer）。下記 | ✓ |
| `/context <依頼>` / `@<agent> /context <依頼>` | 同じ会話の本文を参照してから依頼に答えるよう Agent に送る | ✓ |
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
- Web UI の送り先は**会話ごとに記憶する**（下書きと同じく localStorage。キーは project + 会話 ID）。会話の切り替え・再読み込みでその会話の前回の送り先に戻し、無ければ primary。solo で固定中はそちらが優先
- スラッシュコマンドは 1 行で書く。2 行目以降がある入力は invalid として使い方を表示し、Agent には送らない
- コマンドの一覧は `cli/commands.ts` の 1 か所にまとめ、`/help`・Web UI の候補・CLI の Tab 補完で共有する
- `/context` は本文のある依頼にだけ使う。省略時は primary、`@claude` / `@codex` / `@all` の後にも置ける。Web UI は選択中の送り先を維持し、入力が `@<path>` で始まっても宛先を付ける。`read_conversation` を使う指示は配送時だけ Agent に添え、画面・保存済みの会話本文・配送待ちの表示には出さない（§12）。修正前に保存された指示付き入力も、表示と会話参照では末尾の内部指示を除く。通常の入力と同じく送信・steer・ファイル参照を処理する

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
| `/answer <id> <json>` | Agent の質問（`ask_user`）に答える。画面の回答のボタンもこれを送る（§12 人への質問） |
| `/project [path\|pin <path>\|remove <path>]` | project を開く・切り替える・ピン止め・一覧から外す（§28 D2） |
| `/role [agent] [text] \| preset [name]` | 役割の表示・変更・プリセットの適用（§13 Roles） |
| `/tab [keep|close] <id> <project root>` | タブの会話へ切り替える・タブを固定する・閉じる（§28 D2a のタブ） |
| `/brainstorm [周回数] [--join] <テーマ>` | ブレスト用の会話を作り、全 Agent で案を出して順番に議論し、合意か上限でまとめる。`--join` で人も発言者に加わる（§28 F） |
| `/pass`・`/conclude` | ブレストの人の番で、発言せずに進める・議論を終えてまとめへ進む（§28 F） |
| `/develop [指示]` | まとめを終えたブレストの結論を引き継いで、普通の会話で開発を始める（§28 F） |
| `/steer <id>` | 配送待ちの人間の入力か formal message を、宛先の Agent の実行中のターンに割り込みで足す（§28 v0.3 C）。Web UI は送信待ちの一覧に「割り込み」を出す |
| `/cancel [id]` | まだ配送していない人間の入力か、相手の Agent からの message を取り消す（省略時は最後に送った人間の入力）。配送済みは取り消せない（`/interrupt` を使う）。Web UI は送信待ちの一覧に「編集」「取り消し」を出す（編集は取り消して本文を入力欄に戻す。message は「取り消し」だけ） |
| `/status` | 各 Agent の状態と session ID。停止中は次の起動で使う session（/new 後の新規なら表示しない）。配送待ちの人間の入力（ID・送り先・本文） |
| `/verbose` | terminal の詳細表示を切り替える（§17） |
| `/primary <claude\|codex>` | 通常のテキストの送り先を切り替える（§3.10） |
| `/resume [番号]` | 番号なしで過去の会話の一覧、番号付きでその会話に切り替える（§18） |
| `/rename [#<number>] <title>` | 会話の名前を変える。番号（`/resume` の一覧の番号）を `#` 付きで指定すればその会話、省略すれば今の会話（§18） |
| `/solo [enable\|disable\|claude\|codex]` | 今の会話を solo にする・解除する（§11 Solo）。引数なしは `enable` |
| `/delete <番号>` | 過去の会話を削除する（`/resume` の番号。今の会話は削除できない。§18） |
| `/pin <番号>` | 会話のピン止めを切り替える（`/resume` の番号。§18） |
| `/compact [claude\|codex]` | 会話を要約してコンテキストを減らす。1 ターンとして mailbox で直列に送る。停止中の Agent には何もしない（docs/spikes/compact.md） |
| `/new [claude\|codex]` | 新しい session で始め直す。省略時は両 Agent を新しい会話として、指定時はその Agent だけを今の会話の中で始め直す（§18） |
| `/handoff <claude\|codex>` | その Agent に引き継ぎの資料を書かせてから、その Agent だけを新しい session で始め直す（§14 session の大きさ） |
| `/worktree` | 今の会話を新しい worktree に移す。Agent は今の session のまま続ける（§28 D1） |
| `/permission [claude\|codex] <read-only\|edit\|full>` | Agent（省略時は両方）の権限レベルを切り替える（§9 Permission） |
| `/model <claude\|codex> <model>` | Agent の model を切り替える（§9 Model / Effort） |
| `/effort [claude\|codex] <level>` | Agent（省略時は両方）の reasoning effort を切り替える（§9 Model / Effort） |
| `/limits [<name> <n> ...\|reset\|unlimited]` | Agent 間のやり取りの上限を表示・変更する（§14 上限） |
| `/sandbox [on\|off\|uninstall]` | project の外への書き込みを OS で止める sandbox の表示・切り替え（§9 Sandbox） |
| `/processes [番号]` | 番号なしで `!&` の background process の一覧、番号付きでその process の出力の末尾（§15） |
| `/kill <番号>` | background process をプロセスツリーごと止める（§15） |
| `/language [ja\|en]` | 引数なしで今の言語を表示。指定すると表示の言語（§13 Language）を変え、`~/.clodex/config.json` の `language` に保存する |
| `/help` | 入力方法の一覧 |
| `/exit` | 全 Agent を止めて終了 |

将来の候補: `/agents`, `/tasks`, `/messages`

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
| `tool_end` | tool の終了。`toolId` で `tool` と突き合わせる。コマンドなら終了コード（`exitCode`）、取れなければ失敗かどうか（`failed`）だけ（下記「コマンドの記録」） |
| `turn_started` | ターン開始（Agent が busy になった）。自発ターン（下記）も含む |
| `turn` | ターン完了（`TurnResult`）。自発ターンも含む |
| `rate_limit` | 5 時間 / 7 日の利用率（%）と reset 時刻。プランに無い枠は含めない（Codex は枠の長さ `windowDurationMins` で見分ける。Pro は週の枠だけ） |
| `compacted` | compact が行われた（Claude の `compact_boundary`）。コンテキストの大きさは次のターンまで unknown にする（§14）。Codex は compact 後の `thread/tokenUsage/updated` で大きさが届くので出さない |
| `context` | 今のコンテキストの大きさ（token）と上限。Claude は最後の API 呼び出しの usage と `modelUsage[].contextWindow`、Codex は `thread/tokenUsage/updated` の `last.totalTokens` と `modelContextWindow`。Gemini は `result.usage` の累積の差分（そのターンのプロンプト + 出力）。agy は上限を返さないので window なし（画面は token 数だけ出す） |
| `exit` | プロセス終了 |
| `error` | 認証違反・プロトコルエラー等 |

**コマンドの記録**: 「テストを通した」を Agent の自己申告に頼らず、実際に実行したコマンドと結果を Coordinator が持つ

- `tool` に任意の `toolId`（CLI の tool 呼び出しの ID）・`command`（要約前のコマンド）・`cwd`（コマンドの作業ディレクトリ）を付ける
- Codex: `commandExecution` は `item/completed` で 1 回だけ届くので、`tool`（name: `command`）に `toolId`・`cwd`・`exitCode` をまとめて付け、`tool_end` は出さない。終了コードが `null`（中断など）なら付けない
- Claude: `tool_use` の `id` を `toolId` にする。`Bash` の結果（`user` の `tool_result`）が届いたら、`tool_use_id` で `tool_end` を出す。終了コードは構造化されていないので付けず、`is_error` を `failed` にする（「実行の試み」として扱う。docs/spikes/command-exit.md）
- subagent の中の tool（`parent_tool_use_id` 付き）は出さない（上の `tool` と同じ）

Spike の結果、v0.1 で使う操作（送信・interrupt・resume・MCP）は両 CLI とも対応しているため、capabilities は持たない。機能差が必要になった時点で追加する。

Adapter の必須処理:

- 子プロセスの環境変数から API key を取り除く（§10）
- 子プロセスに `CLODEX_AGENT=<claude|codex>` を設定する。ユーザーの hook や skill が「Clodex 配下の Agent か」を判定できるようにする（例: Agent 単体での委譲 plugin を Clodex 配下では無効にする）
- 認証方式がサブスクリプションでなければ、プロセスを止めて `error` を出す
- 実行中ターンへの追加送信（steer）は v0.1 では使わない。busy 中の `send` は Coordinator 側でキューに積む（§12）
- 予期しない承認要求（Codex の server request）はエラー応答し、`error` を出す。Codex は `approvalPolicy: "never"` で起動し、Coordinator の MCP tool だけ自動承認する
- Codex の応答のうち Clodex が使うもの（`thread/start`・`thread/resume`・`turn/start`・`account/read`）は、使うフィールドの形を確かめてから使う。形が違えば method 名を含むエラーにする（CLI の更新で形が変わったことが分かるように）
- CLI の実行ファイルが見つからないとき（PATH に `claude.exe`・`codex.exe` が無い。npm で入れた `.cmd` だけの場合を含む）は、その旨の文言で起動の失敗にする。shell を介して `.cmd` を起動することはしない（引数がコマンドインジェクションの原因になるため）
- 認証違反などでプロセスを止める（abort）ときは、プロセスの終了を待ってから実行中のターンを `failed`（理由は abort の理由）で終える。終了するまで idle に戻さず、終了中のプロセスに次の入力を送らない
- interrupt してから 30 秒たってもターンが終わらなければ、abort としてプロセスを止める（次の送信で session を resume して起動し直す）
- Codex の JSON-RPC の要求は、120 秒たっても応答が無ければ失敗にする（起動中なら起動の失敗としてプロセスを止める）
- ターンの入力をプロセスに書けなかったとき（添付の画像が読めない、sandbox の broker が切れているなど）は、そのターンを `failed`（理由はエラーの文言）で終えて idle に戻す。busy のまま残さない
- プロセスの終了は stdout を読み切ってから扱う（Node の `close`。`exit` の時点では最後の行が未処理のことがある）
- プロセスを止めるときはプロセスツリーごと止める（Windows は `taskkill /T /F`。Agent が起動した shell や dev server を残さない。docs/spikes/shell-command.md）

自発ターン（Claude。docs/spikes/claude-lifecycle.md）:

- Claude は入力が無くても新しいターンを始めることがある（background で動かした subagent や task の完了通知を受けて続ける）。このターンも `turn_started` → `text` / `tool` → `turn` を出し、その間は busy にする。最終応答は通常のターンと同じく表示する
- 自発ターン中に `send` / `compact` が来たら、そのターンの完了を待ってから送る（mailbox の配送を失敗させない）
- subagent（Task / Agent tool）内部の発言と tool 呼び出し（`parent_tool_use_id` が付いたもの）は、本体の `text` / `tool` として出さない。自発ターンの開始の判定にも使わない
- Codex の subagent（`multi_agent`。既定で有効）は別の thread で動き、その通知も同じ stdout に `threadId` 付きで流れる。自分の thread でない通知は無視する（無視しないと subagent の `turn/completed` で親のターンが終わる）。親の thread の `subAgentActivity` item は `tool`（name: `subagent`）として出す（docs/spikes/steer-image-subagent.md）

## Permission

`-p` / app-server で動く Agent には、その場で人が権限確認に答える手段がない。代わりに、両 Agent 共通の権限レベルを持ち、人が `/permission` で切り替える（docs/spikes/permission.md）。

| レベル | Claude（`--permission-mode` / `set_permission_mode`） | Codex（`sandbox` / `sandboxPolicy`） | Gemini（agy の起動引数） |
|---|---|---|---|
| `read-only` | `plan`（読み取りと計画のみ。ユーザー設定で許可済みの tool でも編集・実行しない） | `read-only` | `--mode plan` |
| `edit`（既定） | `acceptEdits` | `workspace-write`（ネットワーク可） | `--mode accept-edits`（承認が要る操作は headless でソフト拒否） |
| `full` | `bypassPermissions` | `danger-full-access` | `--dangerously-skip-permissions` |

- 既定は `edit`。設定ファイルの `permission` で変えられる（§13 Roles）
- Codex の `edit` はネットワークを許す（起動引数の `-c sandbox_workspace_write.network_access=true` と、`sandboxPolicy` の `networkAccess: true`）。依存関係の取得など、project の作業に要るため。Schannel を使う TLS（`curl.exe`、PowerShell 5.1 の HTTPS）は Codex の sandbox では通らない（docs/spikes/codex-project-config.md）
- Claude は `full` へ後から切り替えられるよう、常に `--allow-dangerously-skip-permissions` を付けて起動する（付けるだけでは bypass にならない）
- 反映: Claude は即時（`set_permission_mode`）、Codex は次のターンから（`turn/start` の `sandboxPolicy`。以降のターンにも引き継がれる）。Gemini は起動引数でしか渡せないので、プロセスを入れ替えて反映する（`--conversation <id>` で同じ会話を続ける。作業中のターンは中断される）
- 停止中の Agent は、次の起動時にそのレベルで起動する
- 起動処理の途中で変更された場合は、起動が終わった時点で反映する
- `/permission` で切り替えた値は project ごとに保存し、次の起動でも使う（下記「Agent の設定の保存」）
- Gemini のソフト拒否からの自動続行: agy は headless だと承認が要る tool を denied にして**ターンをそこで終える**（`result.denied_actions`）。そのままだと途中経過だけ返して止まるため、Coordinator は denied 付きでターンが完了したら、同じ Agent の mailbox に続行の指示（英語の envelope: 拒否された tool 名を挙げ、再試行せず、できる範囲で答えを出すか、必要な権限を言うよう促す）を 1 回だけ積む。続行のターンも denied で終わったら、次の人間の入力までは積み直さない（ループ防止）。画面にはこれまでどおり denied のエラー通知を出す

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
- `/model` は model 名を検証しない（CLI が受け付けなければ、その返事を警告の通知で出す）。model 名は Agent ごとに違うので Agent の指定を必須にする
- `/effort` の値: Claude は `low` / `medium` / `high` / `xhigh` / `max`（`claude --effort`）。Codex は `ReasoningEffort`（文字列。model ごとに対応する値が違う）。Agent を省略したときは effort を持つ全 Agent が受け付ける値だけを許す
- Gemini は effort を持たない（`agy models` の slug が effort 込みで、`--effort` を併用すると矛盾した組み合わせで起動が exit 1 になるため。model の切り替えが effort の切り替えを兼ねる）。`/effort gemini` は拒否し、画面にも effort を出さない
- `/status` と Web UI に、各 Agent の今の model と effort を表示する。CLI の既定のままで実際の値が分からなければ `default`
- 反映の方法（docs/spikes/model-effort.md で実測）: Codex は `turn/start` の `model` / `effort`（以降のターンにも引き継がれる）。Codex には毎ターン effort を明示して送る（依頼ごとの effort を次のターンに持ち越さない）。値は、依頼の `effort`（§11）があればそれ、無ければ人が `/effort` で決めた値、それも無ければ thread の開始時に読んだ既定の値。どれも分からなければ effort を付けず、依頼の `effort` も使わない（戻す値が無いまま上書きすると次のターンに持ち越すため。warn の notice を出す）。Claude は `/model <model>` / `/effort <level>` を user message として mailbox の 1 ターンで直列に送る。CLI の result 文言で成功を確認する。この設定用のターンは `turn_started` / `turn` を出さず、ログに Claude の枠を作らない（CLI の「this session only」という返事は Clodex の保存と食い違って見えるため出さない）。成功したら Clodex が「model を保存: <agent> → <model>」「effort を保存: <対象> → <level>」の 1 行を出し、失敗したら CLI の返事を警告の通知で出す

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
- 異常終了（fatal の例外・`taskkill /F`）では上の処理が走らないので、Windows の Job Object で止める（docs/spikes/orphan-processes.md）
  - Hub は起動時、子プロセスを 1 つも起動する前に、自分を `KILL_ON_JOB_CLOSE` の Job に入れる。Job を作るのは helper（PowerShell の `Add-Type` の C#）で、helper は Hub を Job に登録し、Job の handle を Hub のプロセスに複製してから終わる（helper は常駐しない）
  - Job の handle を持つのは Hub だけなので、Hub がどう終わっても handle が閉じて Job が閉じ、Hub の子孫（Agent・`!command`・`!&` の process とその孫）がすべて止まる
  - 登録に失敗しても起動は続ける（stderr に 1 行出す）。Windows 以外では何もしない
  - sandbox の Agent（別ユーザーのプロセス）が Job に入るか・Job の中から sandbox を起動できるかは未実測。sandbox を使う環境で確かめる

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
- solo を解除したら（`/solo disable`）、各 Agent に次に何かを届けるとき（人の入力・formal message の envelope・利用枠の続きの指示のどれでも）、末尾に一度だけ「solo は解除された。役割どおり `send_message` で相手の Agent に依頼してよい」の 1 行（英語）を足す。solo の 1 行は会話の履歴に残っているので、解除を伝えないと Agent は solo のつもりで続けるため
  - 伝える必要がある Agent は会話の保存に `soloReleased`（Agent の配列）として残し、伝えたら外す（Hub を再起動しても伝え漏れない）。解除したときに両方の Agent を入れる。もう一度 solo にしたら空にする
- 送り先が固定されているとき、ほかの Agent への送信（`@<agent>`・`@all`・`!>` の宛先）は拒否する
- 画面: state の会話に `solo` を入れる。Web UI は送り先が固定されていれば、送り先の切り替えをその Agent にして押せなくする。`free` なら切り替えられる。Web UI と TUI の下の行に「solo」を出す。`/status` にも出す

## Message Types

| type | 用途 | `replyTo` |
|---|---|---|
| `QUESTION` | 相手 Agent への質問 | 任意 |
| `REVIEW_REQUEST` | レビュー依頼 | 任意 |
| `DELEGATE` | 実装・調査の委譲 | 任意 |
| `FIX` | 送った依頼（`DELEGATE` / `REVIEW_REQUEST`）の訂正 | 必須（元の依頼の ID） |
| `ADD` | 送った依頼への要件・作業の追加 | 必須（元の依頼の ID） |
| `NOTE` | 参考情報（作業を変えず知らせるだけ。返信不要）。`replyTo` 付きは送った依頼の続き、無しは単独の連絡（案の共有など） | 任意（付けるなら元の依頼の ID） |
| `CANCEL` | 送った依頼の取りやめ | 必須（元の依頼の ID） |
| `ANSWER` | `QUESTION` への回答 | 必須（`QUESTION` の ID） |
| `RESULT` | 依頼（`DELEGATE` / `REVIEW_REQUEST`）の作業を終えたときの結果返却 | 必須 |
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
| `replyTo` | FIX / ADD / CANCEL / ANSWER / RESULT / ACK で必須 | 返信元の message ID。`FIX` / `ADD` / `CANCEL` と `replyTo` 付きの `NOTE`（以下、続きの message）は自分が送った `DELEGATE` / `REVIEW_REQUEST` の ID でなければ拒否する。`replyTo` 無しの `NOTE` は単独の連絡として通常の message と同じに配送する（Budget も同じ。返信不要なので、依頼の処理中に送っても §12 の最終応答の自動転送は止めない）。`ANSWER` は自分が受けた `QUESTION` の ID でなければ拒否する。`RESULT` で `QUESTION` に返したら拒否する（`ANSWER` を使うよう伝える） |
| `commit` | | 参照する commit hash |
| `files` | | 参照する file path（project root からの相対パス） |
| `spec` | | `DELEGATE` / `REVIEW_REQUEST` / `FIX` / `ADD` / `NOTE` / `ANSWER` / `RESULT` のみ。依頼の仕様を書いた設計書の path（project root からの相対パス）。`ANSWER` では、`QUESTION` に答えるために更新した設計書を渡す。送信時に通常ファイルとして存在しなければ拒否する（project root の外も拒否） |
| `status` | | RESULT のみ。`approved` / `changes_requested` / `done` / `failed` / `canceled`（`CANCEL` で取りやめた） |
| `issues` | | RESULT / ISSUE のみ。`{ file, line?, severity, summary }` の配列。severity は `low` / `medium` / `high` / `critical` |
| `rework` | | `DELEGATE` / `FIX` / `ADD` のみ。同じ task の再依頼の理由。`spec`（設計の不足・誤り）/ `impl`（実装の誤り）/ `check`（検証の不足）。§17 task 単位の計測に使う |
| `effort` | | `DELEGATE` / `REVIEW_REQUEST` のみ、宛先が `codex` のときだけ。その依頼を処理するターンの reasoning effort（§9 Model / Effort）。Claude は effort を設定用のターンで session ごと変えるしかなく、ターン単位にできないので受け付けない |
| `relatesTo` | | `DELEGATE` / `REVIEW_REQUEST` のみ。別の `taskId` で出した、関係する前の task の ID（作り直し・続き）。§17 task 単位の計測に使う |

Coordinator が付与するフィールド（Agent の自己申告は使わない）:

| field | 内容 |
|---|---|
| `id` | message ID（`msg_` + ランダム 8 桁） |
| `from` | 送信元。MCP の URL path で決める（§12） |
| `repository` | project root（§7） |
| `createdAt` | ISO 8601 |
| `specChanges` | `spec` があり、宛先に同じ設計書を前に渡しているときだけ付ける。前回から変わった節の見出し（下記 Spec の差分）。変わっていなければ空配列 |
| `auto` | Coordinator が依頼の最終応答から作った `RESULT` / `ANSWER` にだけ付ける（§12 配送ルール） |
| `specHash` | `spec` の配送した中身の SHA-256 の先頭 12 桁（§13 Spec の差分） |
| `evidence` | `RESULT` のみ。Coordinator が記録から付ける検査の結果と依頼開始後の作業ツリーの差分（§13 検証の証跡） |
| `specCheck` | `DELEGATE` / `REVIEW_REQUEST` のみ。設計書の検査の結果（§13 設計書の検査） |

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
- `parallel`（省略可、boolean）: `DELEGATE` / `REVIEW_REQUEST` のみ。宛先が作業中（実行中のターンか配送待ちがある）なら、子の会話を立ててそこで受けさせる（§28 D1「子の会話で並列に受ける」）。作業中でなければ通常どおり配送する（`worktree: true` を除く。下記）。`interrupt`・`fresh` と両方 `true` なら拒否する（子の会話は常に新しい session）
- `worktree`（省略可、boolean）: `parallel` のときだけ。子の会話を新しい worktree で作業させる（同じファイルに触る危険の判断は送る側が行う）。`worktree: true` なら、宛先が作業中でなくても子の会話を立てる（送る側が作業場所を分けるよう求めているので、本体の作業ツリーで動かさない）
- `fresh`（省略可、boolean）: `DELEGATE` / `REVIEW_REQUEST` のみ（ほかの type は拒否する）。`true` なら、宛先の session を新しくしてから届ける（下記 §12「新しい session で届ける」）。省略時は設定の `freshThread` の既定（無ければ `false`）。`interrupt` と両方 `true` なら拒否する（新しい session には割り込めない）
- 続きの message（`FIX` / `ADD` / `replyTo` 付きの `NOTE` / `CANCEL`）は `interrupt` の指定によらず、宛先が元の依頼（`replyTo`）を処理中なら、そのターンに足す。`fresh`・`parallel` は付けられない
  - `FIX` / `ADD` / `NOTE`: 処理中でなければ（まだ配送待ち・もう終えた）、今の session に通常どおり配送する（`fresh` にはしない。前の作業を覚えている session で受けるため）
  - `CANCEL`: 元の依頼がまだ配送待ちなら、mailbox から外して捨てる（宛先には届けない。message のカードには残す）。処理中なら割り込みで「この依頼の作業をやめ、どこまでやったかを `RESULT`（`status: canceled`）で返す」と伝える。配送待ちでも処理中でもなければ（もう終えた）拒否する
  - 子の会話（`parallel`）で受けた依頼にも同じに使える（子の会話へ届ける）
- 設定の `freshThread` の既定は、`interrupt: true` の message には当てない（割り込みたい依頼が新しい session に回らないように）
- `ANSWER` は `interrupt` の指定によらず、宛先（質問した Agent）が作業中なら、何のターンでもそのターンに足す。質問した後も作業を続けている Agent に、ターンの終わりを待たせずに回答を届けるため。作業中でなければ通常どおり配送する

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
- tool は `send_message`（入力 schema は §11）、`ask_user`（下記）、`read_conversation`（下記）

## 配送ルール（v0.1）

- Agent ごとに mailbox（FIFO キュー）を持ち、人間の入力と formal message を同じキューで直列に送る。実行中のターンには割り込まない
- 宛先 Agent が stopped なら、送る前に起動する。以前の session ID があれば resume する（Lazy Start: Agent は必要になるまで起動しない。§3.2）
- Agent の起動中に届いた配送は、起動の完了を待ってから送る。起動の要求が重なっても起動は 1 回だけ
- `ACK` は記録のみで宛先に配送しない（ACK の往復で Agent を起こさない。§25）
- 送信元への tool 応答は受理結果（message ID）だけを返す。返信は送信元の現在のターンが終わった後、新しいターンとして届く
- 起動や送信に失敗したら Event Bus に `error` を出し、mailbox は次の項目へ進む。人の入力・`/compact`・`ANSWER`・`RESULT`・`ISSUE` は再送しない
- 配送の途中で例外が出たら（送信先のプロセスへの書き込みの失敗など）、その Agent の `error` を出す。待たずに走らせた配送の失敗も黙って捨てない
- 作業を頼む message（`DELEGATE`・`REVIEW_REQUEST`・`QUESTION`）は、配送したターンが失敗（`failed`。混雑や API のエラー）したら 30 秒待って、同じ envelope をもう一度だけ宛先の mailbox に積む。取り消し（`/interrupt`・`/cancel`）と停止（mailbox を閉じた）は失敗に数えない。宛先が利用枠の上限で待っているときも送り直さない（リセット後に続きを送るため。§利用枠の可視化と通知）
  - もう一度失敗したら、送信元の mailbox に「宛先に届かなかった。送り直さずに自分で進める」という指示（英語。message の type・ID・宛先・エラーの 1 行目）を積み、画面に notice（「{to} への {type} が 2 回失敗。{from} が自分で進める」）を出す。`DELEGATE` は自分で実装し、`REVIEW_REQUEST` は自分で確かめ、`QUESTION` は自分で判断して進める
  - 待っている間に Hub が止まったら、再試行はしない（未配送分としても残らない）
  - 再送の envelope には `[Clodex] Retry: your previous attempt at this message failed partway. Check the current state of the files before continuing; do not redo finished work.` の 1 行を添える（前回のターンが途中まで作業していても、やり直しで二重に作業しないように）
- 依頼系の message（`DELEGATE`・`REVIEW_REQUEST`・`QUESTION`）を配送したターンが完了（`completed`）したのに、宛先の Agent がそのターンの間に送信元へ formal message を 1 つも送らなかったら、Coordinator がそのターンの最終応答を `RESULT`（`QUESTION` なら `ANSWER`）として送信元へ届ける（Agent が `send_message` を使わずに普通の返答で報告して終えても、依頼元が結果を受け取れるように）
  - `from` は宛先の Agent、`to` は依頼の送信元、`taskId` は依頼と同じ、`replyTo` は依頼の message ID、`status` は付けない（Agent が完了を宣言していないため。依頼元は本文で判断する）、`body` は最終応答（`MAX_BODY_LENGTH` を超えたら切り詰め、末尾に `…`）。最終応答が空なら送らない
  - Coordinator が作ったことを示す `auto: true` を付ける（Coordinator が付与するフィールド。Agent の入力では受け付けない）。envelope には `Auto: the recipient ended its turn without send_message; this is its final reply.` の 1 行を添える。画面の message の行にも自動で届けたことが分かる印を出す
  - そのターンの間に宛先が送信元へ `ANSWER`・`RESULT`・`QUESTION`・`ISSUE` などを送っていれば、やり取りが続いているので作らない。ターンが `failed`・`interrupted` のとき、割り込み（`interrupt`）で実行中のターンに足した依頼、宛先が利用枠の上限で待っているときも作らない
  - Budget は通常の `RESULT` / `ANSWER` と同じく数える（親は依頼の message）。上限を超えるなら作らず、人に `error` を出す
- **新しい session で届ける**（`fresh`）: 長いタスクを 1 つの session で受け続けると、コンテキストが上限近くに張り付き、tool の呼び出しのたびに大量の token を送り直す（Codex で 3 日・DELEGATE 155 回の 1 本の thread が使用量の 76% を占めた例がある）。新しいタスクを渡すときに、送る側が宛先の session を新しくできるようにする
  - `fresh` の message を mailbox が配送する番になったら、宛先の Agent に `/new <agent>` と同じことをしてから（今の session を会話から外して保存し、プロセスを止める）、新しい session を起動して envelope を送る。届くまでの順番は今どおり（作業中なら今のターンの後）
  - 実際に新しくするのは配送の時点で、宛先の session がすでにある（一度でも起動している）ときだけ
  - 設定の `freshThread`（`{ "DELEGATE": true, "REVIEW_REQUEST": false }` のような type ごとの既定。キーは `DELEGATE` / `REVIEW_REQUEST` のみ）で既定を決められる。message の `fresh` が設定より優先する。Coordinator は受け付けたときに既定を当てはめ、message の `fresh` に結果を入れる（画面と復旧で同じ値を使う）
  - 画面: message のカードに「新しい session」の印を出す（Web UI と TUI。`auto`・割り込みの印と同じ置き方）。コンテキストの大きさは今どおり session の変更で unknown に戻る
  - 新しい session には前の作業の記憶が無い。envelope と設計書（`spec`）だけで作業できるよう、送る側が書く（役割の定型文で伝える: 「新しいタスクを頼むときは fresh を使ってよい。fresh の依頼は前の作業の記憶が無い相手に届く」）。`fresh` と `freshThread` は宛先の Agent を問わない（役割が入れ替わっても同じに使える）。既定は今どおり OFF
  - 新しくすると、宛先の Agent の裏の subagent・background task も止まる
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

## 会話本文の参照（`read_conversation`）

- 同じ会話の Agent は MCP tool `read_conversation` で、その会話の本文を必要なときに読む。自分への入力に加え、ユーザーともう一方の Agent のやり取り、Agent 間の formal message、質問と回答を含む。別の会話の本文は返さない
- 返すのはユーザーの入力、Agent の最終応答、formal message の body、質問・回答の本文だけ。formal message には message の `id`（`msg_…`）を付ける（`replyTo` に使えるように）。途中の text・tool・作業ログ、通知、設定用ターンは含めない
- 各本文の時刻（`at`）は、Hub のある端末の時間帯のオフセット付き ISO 8601（例: `2026-10-09T22:13:38+09:00`）で返す。保存は今どおり UTC。Agent が UTC の時刻をそのまま人に伝え、画面の時刻（端末の時間帯）と食い違うのを防ぐため
- 入力は `{ before?: number, limit?: number }`。新しい順のページを取得し、各ページの本文は時系列で返す。`before` は前の応答の `nextBefore`、`limit` は既定 50・最大 100。全件を system prompt や Task envelope に自動挿入しない
- Event Bus から選んだ本文を会話 ID ごとの JSONL に保存し、Hub の再起動後も読めるようにする。既存の会話は保存済みの feed から読める範囲を初期値にする。MCP server は ConversationRuntime ごとに作るので、tool に会話 ID を指定させない

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
```

- 依頼系（`QUESTION` / `REVIEW_REQUEST` / `DELEGATE`）には返信方法を指示する。返信の body の書式（Markdown で 1 行の要約 → 箇条書き）は定型文（§13 Roles）にあるので envelope には書かない（毎回送り直す token を減らす）。言語の 1 行だけは、長い会話で忘れないよう envelope にも添える
- 末尾に、人が読む文章の言語（下記 Language）を 1 行で添える。長い会話でも依頼のたびに思い出させる
- `ANSWER` / `RESULT` / `ISSUE` には返信を求めない（返信の連鎖を作らない）
- `FIX` / `ADD` の返信方法は、元の依頼への `RESULT`（`replyTo` は元の依頼の ID）。作業を終えたときに 1 つ送る。`NOTE` は返信を求めない。`CANCEL` は `RESULT`（`status: canceled`、やったことと残したもの）
- `QUESTION` の返信方法は `type="ANSWER"`。`DELEGATE` / `REVIEW_REQUEST` は `type="RESULT"` で、作業を終えたときに送るよう添える
- 会話履歴は envelope に含めない。Agent B は必要に応じて `read_conversation` で同じ会話の本文を読むか、Repository を読む
- `spec` があれば `Spec:` 行と「作業の前に読んで従う。コードと食い違う・曖昧なら推測せず QUESTION で聞く」の 1 行を添える。`ANSWER` では「回答に合わせて更新した設計書を読み、続きの作業で従う」の 1 行にする
- `specChanges` があれば `Spec:` 行の直後に書く。空なら `Spec:` 行に `(unchanged since you last received it)` を付け、空でなければ `Spec changes since you last received it:` に続けて節の見出しを 1 行ずつ並べる

## Spec（設計書）

依頼の詳細は body ではなく、リポジトリの中の設計書に書いて `spec` で渡す。body は 4,000 文字までの要約なので詳細を書き切れず、会話にしか残らない。設計書なら相手が何度でも読み返せ、コミットして履歴にも残る。

- 既定の置き場所は `docs/specs/<taskId>.md`。project の CLAUDE.md / AGENTS.md や役割で別の場所を指示してもよい
- `DELEGATE` / `REVIEW_REQUEST` は設計書を書いて `spec` を付けるのを基本にする。body だけで済ませるのは、数行で説明しきれる簡単な依頼だけ
- `QUESTION` に答えるために設計書を直したら、`ANSWER` の `spec` で渡す。`files` に載せるより、読んで従うものだと確実に伝わる
- 設計書の作成・更新・コミットは送信元の Agent が行う。Coordinator は存在を確かめるだけで中身は見ない
- 設計書で実装の範囲（触ってよいファイル）を書くときは、生成コマンド（ビルド・コード生成・辞書の更新など）が書き直すファイルも含める。生成コマンドが書き直すファイルの更新は、書いていなくても既定で許す。役割の定型文でこの方針を伝える（範囲の確認だけの QUESTION の往復を減らすため）
- 役割の定型文（§13 Roles）でこの方針を伝える

### Spec の差分

QUESTION と次の依頼の間に設計書へ書き足すと、受け手はどこが新しいか分からず全文を読み直すことになる。Coordinator は変わった節の見出しを envelope に添える。

- 差分は受理時ではなく、宛先に配送する直前（mailbox が送り始めるとき・実行中のターンに足すとき）に計算する。比べる相手は「宛先の今の session が最後に受けた設計書の中身」。envelope もその時点で作る
- Coordinator は `spec` 付きの message を配送するたびに、宛先 Agent ごと・設計書（実パス）ごとに、中身と宛先の session ID を記録する。記録はメモリだけ
- 前回の記録があり、その session ID が宛先の今の session と同じときだけ `specChanges` を付ける。次のときは履歴が不明なので付けない（受け手は全文を読む）: 初めて渡す、session が変わった（`fresh`・`/new`・`/resume`）、Hub を再起動した。配送待ちのまま取り消された message は配送していないので記録しない
- 配送した中身の SHA-256 の先頭 12 桁を `specHash` として message に付け、envelope の `Spec:` 行に `(sha256:<hash>)` を添える。`RESULT` / `ANSWER` に `spec` があれば同じく付ける（どの版を読んで答えたかを依頼元が確かめられる）
- 節は Markdown の ATX 見出し（`#` 〜 `######`）で区切る。code fence の中の `#` は見出しとみなさない。最初の見出しより前は `(top)` とする
- 見出しの行から次の見出しの直前までを節の中身とし、中身が変わった節と新しい節を見出しの行のまま並べる。消えた節は `(removed) ` を前に付ける。改行コードと行末の空白の違いは無視する
- 全文の diff ではなく見出しにするのは、envelope を短く保つため（§3.3）。中身は受け手が設計書を開いて読む
- 並べる節は 20 件まで。超えた分は `…and N more` の 1 行にまとめる

### 検証の証跡

「テストを通した」「設計書に従った」を Agent の自己申告だけに頼らない。Coordinator が記録から分かる事実を `RESULT` に添える。受入の判断はしない（統合役が行う。§3.9）。

- 設定 `verify`: `{ "implement": ["pnpm test", "pnpm typecheck"], "integrate": ["pnpm test", "pnpm typecheck", "pnpm lint"] }`。`implement` は依頼（`DELEGATE`）を受けた側が `RESULT` の前に回す既定の検査、`integrate` は `RESULT` を受けた側が受け入れる前に回す既定の検査。設計書で追加の検査を書いてよい
  - 定型文（§13 Roles）に両方のコマンドを 1 回だけ書く（`Default checks: implement = …; integrate = …. Run the default checks for your step plus any checks the spec adds.`）。envelope には書かない（重複させない）
- 設定 `specSections`: `{ "owned": "触ってよいファイル", "forbidden": "触らないファイル" }`。設計書の節の見出し（`#` を除いた文字列）の先頭。「所有ファイル（自由に編集してよい）」のように補足の付く見出しも「所有ファイル」で当たる。節の中の箇条書きの `` `path` ``（glob 可。`**` を含む）を範囲とする。無ければ分類しない
  - 除外: `` `!glob` ``と、直後に「以外」が続く `` `glob` ``（「（`*.test.ts` 以外）」）は、その節の除外にする（範囲に足さない）。節の範囲は「どれかの範囲に当たり、どの除外にも当たらない」ファイル。除外だけで範囲の無い節は、すべて（`**`）から除外を引く。書き手が地の文でバッククォートを使っても、除外が編集禁止の範囲に化けないように
  - `specSections` を設定したときは、定型文に節の書き方を 1 行足す（`In the "<owned>" and "<forbidden>" sections of a spec, backticked paths or globs in bullet items define the scope. Write exceptions as `!glob`.`）
- 基準点: `DELEGATE` を配送したとき（配送の直前。§13 Spec の差分と同じ時点）、宛先の作業ディレクトリで `HEAD` と、変更のあるファイル（`git status --porcelain`。未追跡を含む）の中身の SHA-256 を記録する。記録はメモリだけで、依頼 ID ごと。git の外なら記録しない
  - 依頼の `spec` が作業ディレクトリと別の git の作業ツリー（project の中の git worktree など。`git rev-parse --show-toplevel` が違う）の中にあれば、その作業ツリーを基準点と差分の計算・`specCheck` の実行の場所にする。範囲の glob もその作業ツリーからの相対 path で当てる（Agent が会話の作業ディレクトリの外の worktree で作業していても証跡が働くように）
- 証跡（`evidence`）: その依頼への `RESULT`（auto を含む）を受理したとき、Coordinator が次を付ける。Hub の再起動などで基準点が無ければ付けない
  - `checks`: 依頼の配送から `RESULT` までに、宛先の Agent が実行したコマンド（§9 コマンドの記録）のうち、`verify.implement` の各コマンドを単独で実行したものの最後の結果（終了コード、無ければ失敗の印、実行していなければ未実行）
    - 単独の実行: 先頭の `cd <path>;` / `cd <path> &&` と、外側のシェルの包み（`pwsh -Command …`・`powershell -Command "…"`・`bash -lc …` など）を除いた残りが、検査のコマンドそのもの（後ろに引数や `2>&1` が付いてもよい。`|`・`;`・`&&`・`||` を含まない）
    - 検査のコマンドを含むがパイプやつなぎのある実行（`pnpm run check 2>&1 | grep -E "error"` など）は、終了コードが検査のものではない（`grep` は当たりが無いと 1 を返す）。単独の実行が 1 つも無いときだけ「実行したが結果不明」として記録し、終了コードを付けない。単独の実行があればそちらを使う（後のパイプの実行で上書きしない）
    - 定型文の `Default checks` の行に、検査は単独のコマンドで回すことを添える（`Run each check as its own command without pipes or chaining so Clodex can record its exit code.`）
  - `changed`: 基準点の後に変わったファイル（基準点の `HEAD` からの差分と今の変更のあるファイルを合わせ、基準点と中身が同じものを除く）。各ファイルに、設計書（依頼の `spec`）の範囲による分類（`owned` / `forbidden` / `outside`。`specSections` か `spec` が無ければ付けない）と、依頼の間に依頼元の Agent が編集した印（`tool` event の `files`）を付ける。誰が変えたかの証明にはならない（人や別の作業も含む）ので「依頼開始後の作業ツリーの差分」と表示する
  - 100 件を超えたら件数だけにする
- envelope: `RESULT` の末尾に `Evidence (recorded by Clodex):` に続けて検査の行（`pnpm test: exit 0` / `failed` / `not run`）と、変わったファイルの行（分類と印）。差分を計算した場所（作業ツリーの path）を添え、変わったファイルが無ければ `(none)` と書く（空の見出しで終わらせない）。画面: `RESULT` の message カードに同じ内容を折りたためる形で出す

### 設計書の検査

- 設定 `specCheck`: 設計書を検査する project のコマンド（例: `pnpm spec:scope {spec}`。`{spec}` は設計書の path に置き換える）。無ければ何もしない
- `spec` 付きの `DELEGATE` / `REVIEW_REQUEST` を受理したら、宛先の作業ディレクトリで実行する（60 秒で打ち切る）。受理と mailbox への積み込みは今どおりで、配送の直前に検査の完了を待つ（配送の順を崩さない）
- 最初は診断だけにする: 結果（終了コードと出力の末尾 20 行）を envelope に `Spec check (<command>): exit <code>` として添え、配送は止めない。画面へは、検査が終わったら Event Bus に `spec_check` を出し、message カードに結び付けて出す（`message` の publish の順は変えない）。失敗の扱い（拒否に切り替えるか）は誤検出の数を見てから決める

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
- 人が片方の Agent に送った入力と質問への回答は、もう片方の Agent にも、次に何かを届けるとき（人の入力・formal message の envelope・続きの指示のどれでも）に末尾へ添える（`[Clodex] Since your last turn, the human said to <agent>:` に続けて 1 件ずつ。1 件は先頭 300 文字、最大 5 件で、超えた分は件数だけ）。片方にだけ伝えた承認や方針が、もう片方に届かないのを防ぐため
  - 対象は、前回その Agent に届けた後に、人が相手の Agent に送った入力（`@all` で両方に送ったものは除く）と、相手の Agent の質問への回答（質問の見出しと回答）。届けたら消す。保存はしない（Hub を再起動したら消える。本文は `read_conversation` で読める）
  - 添えた行は画面・保存した会話本文・送信待ちの表示には出さない
- 守られることは保証できない（自動翻訳はしない）。英語が残る場合は指示の文言を見直す
- Clodex の画面の文言（Web UI・CLI・通知）もこの言語で出す（§28 v0.3 の i18n）
- `/language` で変えると、Clodex の画面はすぐに切り替える（Web UI は画面の版が変わるので再読み込みする）。Agent に毎回添える言語の 1 行も次の入力から変わる。system prompt の指示は、次に始める session から変わる

## Roles（v0.2）

ユーザーは設定ファイルで、各 Agent の役割と既定の primary を指定できる。

| ファイル | 用途 |
|---|---|
| `~/.clodex/config.json` | ユーザー全体の既定 |
| `<project root>/.clodex.json` | project ごとの上書き（下記「設定の層」） |

```json
{
  "primary": "claude",
  "permission": "edit",
  "roles": {
    "claude": "設計とレビューを担当する。実装は codex に DELEGATE する。",
    "codex": "実装を担当する。設計に迷ったら claude に QUESTION する。"
  },
  "rules": {
    "claude": "コミットメッセージは日本語で書く。",
    "codex": "変えたファイルのテストだけを回す。"
  }
}
```

- **設定の層**: project の設定はユーザーの設定にキー単位で重ねる
  - 値がオブジェクトの設定（`roles`・`freshThread`・`usageHints`・`limits`・`worktree`・`web`・`usageAlert`）は、1 段下のキーごとに上書きする。project に `roles.codex` だけを書いても、ユーザーの `roles.claude` は残る
  - `threadTokenWarn` は、両方がオブジェクトのときだけキーごとに上書きする。どちらかが数なら project の値をそのまま使う
  - `rules` だけは上書きせず、Agent ごとにユーザーの分の後に project の分を足す（改行でつなぐ）
  - それ以外の値は project の値で上書きする
- `rules`（Agent ごとの文字列）は、役割と別に、どの役割でも守らせる共通の作法（コミットの書き方・テストの回し方など）。空文字は未設定。役割の行の後に `Rules:` に続けて入れる。ブレストの会話には入れない
- 設定元: 役割は実効値と設定元（`user` / `project`）を、`rules` は層ごとの文字列と設定元を持つ。`/role` は役割の後に `(project)` / `(user)` を付け、`rules` を設定元ごとに出す。Web UI の設定は役割の欄に設定元の印を出し、`rules` を読み取り専用で出す（編集は設定ファイルで行う）
- `/role <agent> <text>` で保存したら設定を読み直す（project に片方だけ書いても、もう片方の実効値は層どおりに決まる）

- `permission` は起動時の権限レベル（§9 Permission）。両 Agent に同じレベルを使う
- `worktree.setup` は `/new worktree` の直後に worktree で実行する command（§28 D1）
- `freshThread` は `send_message` の `fresh` の type ごとの既定（§12「新しい session で届ける」）
- `usageHints` は使用量を減らす作法を Agent ごとに ON にする（下記。既定は両方 OFF）
- `threadTokenWarn` は、Agent のコンテキストの大きさがこれを超えたら警告する token 数（§14「session の大きさ」）。既定は無し（警告しない）。数か Agent ごとの数（`{ "claude": 150000, "codex": 150000 }`）
- `verify`・`specSections`・`specCheck` は §13 検証の証跡・設計書の検査
- `updateChannel`（`stable` / `dev`、既定 `stable`）は GUI の更新の取得先（§28 GUI の自動更新）。GUI はユーザーの設定だけを読む
- `~/.clodex/config.json` が無ければ、起動時に役割を空にしたひな形を作る（`{ "roles": { "claude": "", "codex": "" } }`）。役割の文章は書かない（書くのは人）。既にあれば触らない。作れなくても起動は続ける
- 役割の空文字は未設定として扱う（ひな形のままでも、役割が無いのと同じ）
- UTF-8（BOM の有無は問わない。Windows PowerShell 5.1 は BOM 付きで書く）
- 優先順位: 起動オプション > project の設定 > ユーザーの設定 > 既定値（primary: `claude`、roles: なし）。重ね方は上の「設定の層」
- Coordinator は Agent の起動時に、固定の定型文と役割を system prompt に追加する（Claude: `--append-system-prompt`、Codex: thread の `developerInstructions`）。定型文は「相手の Agent がいること」「自分と相手の役割」「相手の役割の作業は `send_message` で依頼すること」「権限は人が `/permission` で変えるので、拒否されたらそう伝えること」「依頼を受けたら、作業に入る前に何をするかを 1〜2 文で書くこと」「`send_message` の body は Markdown で 1 行の要約 → 箇条書きで書くこと」「依頼（`DELEGATE` / `REVIEW_REQUEST`）は基本的に設計書を書いて `spec` で渡し、body だけにするのは数行で済む簡単な依頼に限ること。QUESTION には ANSWER で答え、設計書を直したら ANSWER の `spec` で渡すこと（上の Spec）。RESULT は依頼の作業を終えたときに使うこと」「人が読む文章の言語（下記 Language）」を伝える
- 役割が無い Agent には、相手の Agent がいることだけを伝える
- **定型文の作法**（`role-instructions.ts`。手戻りと往復を減らす）
  - QUESTION の body は 3 行で書く: `Decide:`（決めてほしい点）/ `Blocked:`（回答を待つ作業）/ `Continuing:`（回答を待たずに進める作業）。回答に依存する作業は止める
  - 設計書は「固定」（挙動・不変条件・公開インターフェース・編集してよい範囲）と「裁量」（実装の方法など、受け手が決めてよいこと）の節に分けて書く。受け手は固定の節に反することをする前に QUESTION する
  - `send_message` で RESULT を送ったら、ターンの最終応答は 1 行にする（同じ内容を二度書かない）
  - 同じ task のやり直しを頼むときは、新しい taskId を作らず同じ taskId で送り、`rework` に理由を付ける（task 単位の計測で再依頼として数えるため）
  - 人に実行してもらうコマンドは PowerShell の書き方で示す（Clodex は Windows ネイティブで、人の terminal は PowerShell。Agent の shell が Git Bash でも、示すコマンドは合わせない）
  - git の index を変える操作（`git add`・`git rm`・`git mv`・`git stash`）は、コミットする Agent だけが行う。ほかの Agent はファイルの削除・移動を普通のファイル操作で行う（実装役が `git rm` でステージした削除が、統合役の別のコミットに混ざったことがあるため）
- **使用量を減らす作法**（`usageHints`）: 待ち方とファイルの読み方の作法を定型文に足す（英語）。tool の呼び出しのたびにコンテキスト全体を送り直すので、呼び出しの回数がそのまま使用量になるため。役割の分け方は人によって違う（Claude が実装する運用もある）ので、Agent ごとに人が設定で ON にする。既定は両方 OFF
  - 設定: `"usageHints": { "claude": false, "codex": false }`。反映は次に始める session から（system prompt に入るため）
  - 共通: 小刻みにポーリングしない（`sleep` で待つ・subagent の完了を細かく確かめる、を繰り返さない）。ファイルは関係する範囲をまとめて読む。数十行ずつ読まない。同じ内容を読み直さない。何も変えていないのに同じコマンド（テスト・型チェック）を回し直さない
  - Codex: 長いコマンド（テスト・ビルド）は `yield_time_ms` を十分長くして、1 回の呼び出しで終わるまで待つ。`wait`・`write_stdin` で細かくポーリングしない
  - Claude: 長いコマンドは Bash の `timeout` を十分長くして（最大 600000ms）、1 回の呼び出しで終わるまで待つ。`run_in_background` にしたコマンドを `sleep` や出力の読み直しで細かく確かめない
- **プリセット**: よくある分担の役割の文章を、選ぶだけで設定できるようにする（役割が空のままだと分業が起きず、初めて使う人に価値が伝わらないため）。文章を選ぶのは人なので、分け方を固定しない原則（§3.1）とは矛盾しない
  - `design-review`（設計・レビュー・コミットは Claude、実装は Codex）、`codex-design`（設計・レビューは Codex、実装・コミットは Claude。Codex は `edit` ではコミットできないため）、`implement-review`（設計・実装・コミットは Claude、レビューは Codex）の 3 つ。文章は表示言語（§13 Language）で選ぶ
  - `/role preset <name>` で両 Agent の役割をまとめて project の `.clodex.json` に保存する（`/role` と同じく、反映は Agent の次の起動から）。`/role preset` だけなら一覧を出す
  - Web UI は設定の project の節にプリセットの選択を置く。今の役割がどのプリセットとも一致しなければ「カスタム」と出す。選ぶと `/role preset <name>` を送る
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
- 結果（`ANSWER` / `RESULT` / `ISSUE`）を処理中に送った依頼は、処理中の message と同じ深さ（2 回目のレビュー依頼など、同じ階層での継続）
- 依頼以外の message の深さは、処理中の message と同じ（無ければ 1）

上限を超える message は受理せず、送信元へ tool エラーで理由を返し、Event Bus に `error` を出す。エラー文では「上限に達したので人間に報告する」よう Agent に促す。人に見せる `error` には変え方を添える（例: `maxMessagesPerChain (8) に到達（/limits messages <n>）`）。

人は `/limits` で上限を表示・変更できる:

- `/limits`: 4 つの上限の今の値と、既定値から変わっているかを表示する
- `/limits <name> <n> [<name> <n> ...]`: 上限を変える。複数の組をまとめて変えられる（設定画面の「適用」は変えた項目をまとめて 1 回で送る）。`name` は `messages`（`maxMessagesPerChain`）・`reviews`（`maxReviewRoundsPerChain`）・`delegations`（`maxDelegationsPerChain`）・`depth`（`maxDelegationDepth`）。`n` は 1〜100 の整数。1 つでも範囲外・不明な名前・同じ名前の重複があれば、何も変えずに使い方を表示する
- `/limits reset`: 保存した値を消し、設定ファイル（無ければ既定値）に戻す。無制限も解除する
- `/limits unlimited`: 4 つの上限をすべて無くす（無制限）。`.settings.json` に `limitsUnlimited: true` として保存する。`/limits <name> <n>` で値を変えるか `/limits reset` で解除する。無制限の間も chain は数える（`/interrupt` で閉じた chain の拒否は今どおり）。`/limits` の表示と起動時の案内に「無制限」と出す
- 設定画面の上限の欄に「無制限」のスイッチを置く（on で `/limits unlimited`、off で `/limits reset`。無制限の間は on）
- 反映は即時。進行中の chain にも新しい上限を使う（上限に当たって止まったやり取りを、上げてから続けられるように）
- 対象は project 全体（その project のすべての会話の Coordinator）
- 変えた値は project ごとに保存する（§9「Agent の設定の保存」の `.settings.json` の `limits`）。起動時の優先順位は、保存した値 > 設定ファイルの `limits` > 既定値。保存した値で起動したときは起動時の案内に表示する（例: `saved settings: limits messages 16`）

## 利用枠の可視化と通知（v0.2）

Agent Adapter の `rate_limit` event（Claude: `rate_limit_event`、Codex: `account/rateLimits/updated`）から、Agent ごとに最新の利用状況を保持する。

- **週のペース超過** = 週の使用率 − 週の経過率（経過率は reset 時刻と週の長さ 7 日から計算）。正なら使いすぎ、負なら余裕あり
- `/status` に、各 Agent の 5 時間枠の使用率と週のペース超過、コンテキストの大きさ、現在の primary を表示する。まだ受け取っていない値は `unknown`
- コンテキストの大きさは、その Agent の session が変わったとき（`session` event、`/new`、`/resume`）と compact したとき（`compacted` event）に unknown に戻す
- **session の大きさ**: Agent ごとに、今の session の累計の入力 token（キャッシュから読んだ分を含む）を持つ。コンテキストの大きさと合わせて、Web UI の利用状況（ポップオーバーと右の列）、スマホの Agent のシート、TUI の下の行、`/status` に出す
  - Codex は `thread/tokenUsage/updated` の `total`、Claude はターンの結果の usage（入力・キャッシュの作成・読み取り）を足していく。session が変わったら 0 から数え直す。Hub を再起動したら Claude は 0 から（Codex は届いた `total` を使う）
  - `threadTokenWarn` を設定していれば、コンテキストの大きさがそれを超えたら、その session で 1 回だけ warn の `toast`（「{agent} の文脈が {tokens} を超過。/handoff {agent} を検討」）を出し、Agent のカードのコンテキストのゲージを警告の色にする。session が変わったら再び警告できる
- **引き継ぎ**（`/handoff <agent>`）: 統合役の session が大きいまま何日も続くと、tool の呼び出しのたびに大量の token を送り直す。`/new <agent>` だけでは決定事項や未解決の点が失われるので、人が区切りで引き継ぎを指示できるようにする
  - 受け付けるのは、その Agent が idle で、その Agent の mailbox に配送待ちが無く、その Agent 宛ての依頼（`DELEGATE`・`REVIEW_REQUEST`・`QUESTION`）を mailbox で処理中・配送待ちでなく（返事の有無では見ない。返事の無いまま終わった古い依頼で使えなくならないように）、subagent・background task が動いていないときだけ。満たさなければ理由を warn で出して何もしない。その Agent が送って返事を待っている依頼はあってよい（資料に書かせる）
  - 1. 固定の指示（英語）を人の入力と同じく 1 ターン送る。資料の path は Coordinator が決める（`<artifacts>/handoff-<agent>-<時刻>.md`）。書かせる内容: 決定事項・未解決の点・人の最新の判断・証跡（commit・設計書・スクリーンショット）の path・返事を待っている依頼（message ID と taskId）。最終応答は path の 1 行だけ
  - 2. ターンが `completed` で、資料が空でないファイルとしてあれば、`/new <agent>` と同じ処理をする。失敗・中断・資料が無いときは切り替えずに warn を出す
  - 3. 新しい session への最初の配送（人の入力でも message でも）に、`[Clodex] Handoff: your previous session wrote <path>. Read it before continuing.` を添える。添えるだけで、ターンは起こさない（§3.6 の表は増やさない）。Hub を再起動したら添えない（資料は残るので、人が path を渡せる）
  - 自動では引き継がない。自動の compact も入れない（task 単位の計測の数字を見てから決める）
- Clodex の起動時に、model の一覧と同じ短命のプロセスで両 Agent の利用状況も取得し、Agent の Lazy Start を待たずに表示する（docs/spikes/model-list.md）。ターンを送らないので利用枠を消費しない。取得は Hub で 1 回、全 project の UsageMonitor に `rate_limit` event と同じ形で渡す（通知の判定も同じ経路）
  - Claude: `control_request` の `get_usage` の `rate_limits.five_hour` / `seven_day`。`utilization` は 0〜100 の percent、`resets_at` は ISO 8601 の文字列（`rate_limit_event` の比率・epoch 秒とは形式が違うので変換する）
  - Codex: `account/rateLimits/read` の `rateLimits.primary` / `secondary`（`windowDurationMins` で 5 時間・週を見分ける。今の Adapter と同じ変換）
- その後はターン中の `rate_limit` event で更新する。起動時に取得した値より新しい event が来れば上書きする
- 次の条件を初めて満たしたとき、1 回だけ通知する（同じ条件では繰り返さない。reset 後は再び通知できる）。「1 回」は Hub 全体で数える（会話ごと・並列の子の会話ごとに重ねて出さない）

| 条件 | 既定の閾値 | 通知例 |
|---|---|---|
| 週のペース超過が閾値以上 | +15 ポイント | `[CLODEX] claude is ahead of weekly pace (+18). Try /primary codex` |
| 5 時間枠の使用率が閾値以上 | 90% | `[CLODEX] claude 5h usage: 92%` |

- 閾値は設定ファイルの `usageAlert` で変更できる
- 送り先の切り替えは自動で行わない（§3.6）。人が `/primary` で切り替える

上限での停止と自動再開:

- 上限に達したときの CLI の出力（エラーの文言・種類）は実測できていないので、文言では判定しない。Agent に送ったターンが失敗（`failed`）し、その時点でその Agent の最新の利用状況に、使用率が 100% 以上でリセット前の枠（5 時間・週）があれば、上限で止まったとみなす（リセット時刻は、該当する枠のうち遅いもの）
- 上限で止まったら、その Agent の mailbox の配送を止め（残りの項目は捨てずに待たせる。続けて送って失敗させない）、notice（「{agent} が利用枠の上限。{時刻} に再開」）を出す
- Agent が自分から始めたターン（Claude が裏の subagent や task の完了を受けて続けるターンなど。mailbox が送っていないもの）が失敗したときも同じ判定をし、上限なら同じように配送を止めて再開を予約する（裏で subagent を動かしていると、上限に当たるのがこのターンになりやすい）
- 上限で止まったら、相手の Agent に知らせる（`[Clodex] <agent> hit its usage limit and resumes at <時刻>. Its last plan: <方針の 1 行目>. Files it edited in its last turn: <ファイル>. Do not edit these files until it resumes.`）。相手が作業中なら実行中のターンに割り込みで足し（steer）、そうでなければ次に届けるものの末尾に添える。solo のときと、相手が止まっている（stopped）ときは知らせない
  - 編集したファイルは、止まった Agent のそのターンの `tool` event の `files`（Edit・Write など）から集める。無ければその部分を省く
- 再開の指示（続きの指示）には、止まっている間に相手の Agent が編集したファイル（`tool` event の `files`）を添える（`While you were stopped, <agent> edited: <ファイル>. Check them before continuing.`）。無ければ添えない
- ファイルのロック（相手が作業中のファイルへの書き込みを止める・警告する）は作らない。上の知らせで足りなければ考える
- リセット時刻の 1 分後に、mailbox の先頭に「利用枠が戻った。止まった作業を続ける」の指示（英語。人の入力と同じく言語の 1 行を添える）を積んで配送を再開する。止まったターンの入力は session に残っているので送り直さない
- 待っている Agent は復旧の状態で「作業中だった」に含める。Hub を再起動したら、復旧の「続き」を送り、まだ上限なら同じ判定でまた待つ
- 待っている間に人が `/interrupt` したら、待つのをやめ、続きの指示は積まずに配送を再開する
- 待っている間に積まれた項目は、リセット後に送られる前に人が確かめて減らせるようにする
  - state に、配送待ちの formal message（`pendingMessages`: message ID・宛先・送信元・type・taskId・本文）と、Agent ごとの再開時刻（`AgentState.holdUntil`。ISO 8601。待っていないときは無し）を含める。人間の入力は今どおり `pendingInputs`
  - Web UI の送信待ちの一覧に、人間の入力と formal message を積まれた順に並べる。message の行は「送信元 → 宛先」・type・本文の 1 行目と「取り消し」（`/cancel <message ID>`）。上限で待っている Agent 宛ての行には、一時停止のアイコンと再開時刻を添える（title に「再開 <時刻>」）
  - `/cancel <message ID>` は、配送待ちの formal message を mailbox から外して捨てる。送信元の Agent には知らせない（返事が来ないだけ。必要なら人が伝える）。取り消しの知らせは人間の入力と同じ（ログに入れず `toast` だけ）
  - `/status` の送信待ちの行と TUI の件数に message も含める。`/cancel` の引数の候補にも message ID を出す（説明は「送信元 → 宛先 type」）

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
| `retry` | 依頼の再送（§12 配送ルール）。宛先・message ID・何回目か |
| `spec_check` | 設計書の検査の結果（§13 設計書の検査）。message ID と結果。feed に保存し、画面は message カードに結び付ける |

全 event に Coordinator が `at`（ISO 8601）を付ける。購読者の例外は他の購読者と publish 元に波及させない。

WorkRecorder は Agent ごとに、今のターンで実行したコマンド（コマンド・`cwd`・終了コードか失敗の印）を順に持つ（1 ターン 200 件まで。古いものから捨てる）。`tool_end` は `toolId` で同じターンのコマンドに結び付ける

## task 単位の計測

改善の効果を感覚ではなく task 単位の数字で比べるため、Coordinator がターンと message を `taskId` に結び付けて記録する。内容は解釈しない（数えるだけ）。

- 保存先: `~/.clodex/metrics/<project の state のキー>.jsonl`（Event Log と別。消さない）。1 行 1 レコード。集計は読むときに行う
  - `turn`: ターンが終わるたびに 1 行。会話 ID・Agent・`taskId`（無ければ未割当）・開始と終了の時刻・状態・入力 token（キャッシュから読んだ分を除く）・キャッシュから読んだ入力 token・出力 token
  - `message`: Coordinator が受理した formal message ごとに 1 行。会話 ID・ID・type・`taskId`・from / to・`replyTo`・`status`・`rework`・`relatesTo`・`auto`・`fresh`
  - `delivery`: 依頼系の message（`DELEGATE`・`REVIEW_REQUEST`・`QUESTION`・`ANSWER`・`RESULT`）の配送を始めたときに 1 行。message ID と待ち時間（受理から配送開始まで）
- ターンの `taskId`: そのターンで配送した envelope の message の `taskId`。人の入力・自発ターン・`/compact` のターンは未割当。実行中のターンに別の task の message を足した（割り込み）ターンは未割当にする（1 つのターンを複数の task に分けない）
- token は、ターンの間に届いた 1 回分の usage を足して出す（Claude は `result` の usage、Codex は `thread/tokenUsage/updated` の `last`。`last` は直前の通知からの `total` の増分と一致する）。session の累計の差は使わない（Codex の `total` は resume した thread の過去の分を含むので、Hub の再起動や `/resume` の後の最初のターンが過大になる）
- 集計（task ごと）: ターン数・入力 token（キャッシュ分は別）・出力 token・所要時間（ターンの時間の合計）・待ち時間の合計・最初から最後までの時間・`QUESTION` 数・`RESULT` 回数・再依頼数（同じ `taskId` の 2 回目以降の `DELEGATE`、と `FIX`・`ADD`）・`rework` の内訳。未割当のターンは会話ごとに別に合計する
- 受入: task の最後の `RESULT` が `done` / `approved` で、その後に同じ `taskId` の `DELEGATE`・`FIX`・`ADD` が無ければ「受入完了」とみなす。`RESULT` が 1 回だけで受入完了なら「初回受入」
- 画面: `RESULT` の message カードに、task の累計（ターン数・入力 token・所要時間・`QUESTION` 数）を小さく出す。累計は `RESULT` を送ったターンの終了時まで反映して固定し、その後の再依頼の分は前のカードに足さない。`/status` に今の会話の最近の task（5 件）の累計を出す
- 基準値: `scripts/task-metrics-baseline.ts` が過去の Event Log から同じ集計を推定する（ターンと message の対応は記録に無いので、宛先の mailbox の順で推定する）。導入前の Event Log は `~/.clodex/metrics-baseline/logs/` に写してある
- 並列の子の会話の message は、子と親の両方の会話に記録される（それぞれの会話の表示に要る）。project 全体で集計するとき（基準値の script を含む）は message ID で重複を除く

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
| 途中の発言（2 つ目以降の `text`）・`tool`・`tool_end`・`usage`・`rate_limit`・`session`・`exit`・`retry` | × | ✓ |

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

クライアントの組み立て:

- 画面の振る舞いは `src/web/client/` に TypeScript のモジュールとして書き、入口（`src/web/client/index.ts`）から esbuild で 1 つの script（IIFE）に bundle する。CSS は `src/web/client/style.css` に置く。どちらもページに inline で埋め込む（HTML 1 枚のまま）
- `pnpm build` で `dist/web/client.js` と `dist/web/style.css` を作る。GUI に同梱するのはこの成果物で、esbuild は同梱しない（devDependency）。ソースから動かすとき（`pnpm dev`・テスト）は、成果物が無ければ起動時に esbuild で bundle する
- 画面に渡す値（文言のカタログ・コマンドの一覧・画面の配置・版）は、`<script type="application/json">` に JSON で置き、入口が読む。関数のソースを `toString()` で埋め込まない
- 画面の版（再読み込みの判定。§17）は、bundle・CSS・HTML・渡す値から作る
- フォント（Geist・Geist Mono・Zen Kaku Gothic New）は `@fontsource` のパッケージを依存に入れ、Hub が `/fonts/...` で配る。外部（Google Fonts）から読まない（オフラインでも同じ見た目にし、読み込み前の表示の揺れを無くす）。`@font-face` は `unicode-range` で分かれたファイルを使い、使う文字の分だけ読む。フォントは秘密を含まないので token なしで返し、長くキャッシュさせる（ファイル名に版を含むか、パッケージの版で URL を変える）

### 接続と認証

- **起動**: `clodex --web` または設定ファイルの `"web": { "port": 4319 }`。既定ポートは 4319
- **待ち受け**: `127.0.0.1` だけ。外部からの接続は Tailscale の `tailscale serve`（tailnet 内の端末だけが HTTPS で入れる）に任せ、Clodex は `0.0.0.0` で待ち受けない
- **認証**: 起動をまたいで同じ token を使う（`~/.clodex/web-token`、初回に生成）。`/?token=<token>` で開くと HttpOnly cookie を設定し、以後は cookie で認証する。token が無い・違うリクエストは 401
- 依存パッケージを増やさない（`node:http` と SSE のみ。画面も外部の JS ライブラリを使わない）。例外は Hub 側で QR コードを作る `qrcode` と、同梱のフォント
- **スマホからの接続の案内**: 設定の Clodex の節に「スマホ」の行を置き、開くとスマホで読み取る QR コードと接続の URL（`?token=` 付き）を出す。URL はコピーできる
  - URL は tailscale の CLI（PATH に無ければ `C:\Program Files\Tailscale\tailscale.exe`）から求める。`tailscale status --json` の `Self.DNSName` と、`tailscale serve status --json` の `Web` のうち、Hub のポートへ proxy している `/` の handler の HTTPS の入口（例: `https://<name>.<tailnet>.ts.net/`）。パス付きの handler（`/clodex` など）は、画面がルートからの絶対パスを使うので使えない（`serve` 未設定と同じ扱い）
  - 状態は 4 つ: 接続できる / `serve` が Hub のポートに向いていない（`tailscale serve --bg <port>` を出してコピーできるようにする）/ tailscale が止まっている / tailscale が無い。文言は短く（「serve 未設定」「Tailscale 停止中」「Tailscale 未導入」）
  - API: `GET /api/connect`（token 認証）が状態・URL・QR コードの SVG を返す。QR コードは Hub が `qrcode` パッケージで作る。開くたびに tailscale に問い合わせる（キャッシュしない）
  - token を含むので、出すのは認証済みの画面だけ。`/api/connect` を token なしで返さない
- **token の再発行**: URL が漏れたときに、前の URL と、それで入った端末の cookie を使えなくする。設定の「スマホ」の行に「再発行」を置く（押すと確認を出す: 「今の URL とログイン中の端末は使えなくなる」。押せるのは認証済みの画面だけ）
  - API: `POST /api/connect/rotate`（token 認証）。新しい token を作って `~/.clodex/web-token` に書き（一時ファイル経由）、Hub が以後の認証に使う token を入れ替える。前の token の cookie と `?token=` は 401 にする
  - 今つながっている feed（SSE）はすべて閉じる（前の token で入った端末を残さない）。再発行した画面には、応答で新しい token の cookie を付ける（その画面はそのまま使える）。応答は `GET /api/connect` と同じ（新しい URL と QR コード）
  - ほかの画面は再接続で 401 になる。Web UI は「新しい URL で開き直す」状態（再接続を繰り返さない）を出す。GUI の中の Web UI は、GUI に `~/.clodex/web-token` を読み直してページを開き直させる（GUI の command）。TUI は 401 を受けたら `~/.clodex/web-token` を読み直して 1 回だけつなぎ直す（同じ PC のファイルを読めるため）
  - Web Push の購読は token と別なので消さない

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
  - 会話・project の操作の結果: `/new`（worktree を含む）・`/worktree`・`/resume`・`/rename`・`/delete`・`/pin`・`/project <path>` の完了と失敗
  - ほかの会話で Agent のターンが終わったこと（§28 D1）
  - 同じ作業場所で別の会話が作業中であること（§28 D1）
  - Coordinator の通知（`notice`。`@all` の送信・復旧・利用枠の上限での待機・受け渡しの失敗・配送待ちの破棄・利用ペースの警告など）。feed に保存せず、読み込み直しても出さない。受け渡しの失敗・上限での待機・利用ペースの警告は warn、ほかは info。上限で待っていることと再開の時刻は、Agent のカードと送信待ちの行で見える。compact の区切り（`compacted` から作る行）は `notice` ではないので、今どおりログに出す
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
  - ヘッダ: 左に「Clodex」と project の pill（folder アイコン + project 名 + chevron。押すと project の一覧。パスは pill の `title` に出し、本文に重ねて出さない）と「project を開く」。右にアイコンのトレイ（詳細、資料、成果物、テーマ、設定）
  - 左の列: 会話の一覧（見出しに「新しい会話」のアイコン）
  - 右の列: 上に **Agent ストリップ**（Agent ごとのカードを横に 1 行。3 体で文字が詰まらないよう、カードは 2 つの形を使い分ける）、その下にログと入力欄
    - **展開カード**: mark（スマホの Agent ピルと同じく、周囲にコンテキストの円環・状態の点・full の盾を重ねる）・名前・状態 pill・model / effort / 権限・利用枠の 2 つの小さな円環（5 時間と週。中にアイコン〔時計 / カレンダー〕、% の文字は出さず `aria-label` と title に。値が無い Agent は薄く出す）・中断 / Compact / 設定のアイコン。「コンテ」「5 時間」「週」の文字ラベルと横のミニゲージは置かない（3 枚では詰まるため）
    - **畳みタイル**: mark（円環・状態の点つき）だけの細いタイル。名前と状態は title と `aria-label` に
    - 使い分け: 停止中（`stopped`）かつ送り先に選んでいない Agent は畳みタイル、それ以外は展開カード。畳みタイルを押すとその Agent を展開し、もう一度押すと畳む（手動の展開は端末の画面の状態。保存しない）。会話を切り替えたら手動の展開は解除する
    - グリッドの列は展開カードに広く、畳みタイルに狭く割る（タイルは 44px 以上の押せる幅）
    - 円環（mark のコンテキスト・利用枠の 2 つ）を押すと、カードの下に利用状況のポップオーバー（コンテキストの使用量と上限、5 時間・週の使用率・reset 時刻・ペース）を開く（外のクリックか Esc で閉じる）
  - 画面が広いとき: 会話の一覧は常に左端に置き、右の列（Agent ストリップ・ログ・入力欄）は今の最大幅（1060px）のまま画面の中央に置く（会話の一覧と重なるなら、重ならない位置まで右へ寄せる）。右の余白が利用状況のパネルを置けるほど空いたら（幅 1700px 以上）、右端に全 Agent の利用状況（ポップオーバーと同じ中身）を常に出し、円環のポップオーバーは開かない
- スマホ（上以外）: PC の縮小ではなく、チャットアプリの形にする
  - ヘッダは 1 行（48px + safe-area）: 左に会話のドロワーを開く ≡、中央に会話名（下に小さく project 名）、右に Agent ピル 2 つ（状態の点 + コンテキストの円環。`full` は点の横の小さな盾）と ⋯（資料・成果物・テーマ・設定・詳細・project）。Agent ごとの状態の行は置かない
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
    - **sandbox**: スイッチ（`role="switch"`・`aria-checked`）と、セットアップ済みかを示すアイコン（文で書かない。`aria-label` と title に「セットアップ済み」「未セットアップ」）。切り替えると `/sandbox on|off` を送る。切り替えの間はトップのバーを出す
    - **上限**: 4 つの上限（§14）を数値で変える。既定値と違う項目は分かるようにする。「適用」は欄に 1 つだけ置き、今の値から変えた項目をまとめて `/limits <name> <n> ...` で送る（変えた項目が無いか、範囲外の値があるときは押せない）。「既定に戻す」で `/limits reset` を送る。「無制限」はスイッチにし、on で `/limits unlimited`、off で `/limits reset` を送る
  - **端末**: 送信キー・通知
    - **送信キー**: 「Enter で送信」/「Ctrl+Enter で送信」。端末の localStorage に保存し、Hub には送らない。スマホでは出さない
    - **通知**: スイッチ。下記 Web Push（§28）
  - **Clodex**: 言語・GUI の版と更新
    - **言語**: 日本語 / English。選ぶと `/language <ja|en>` を送る
    - **GUI の版と更新**: 下記 GUI の自動更新（§28）。GUI につながっていないときは出さない
- 各項目は 1 行にまとめ、左に名前・右に操作を置く（スマホでも同じ。操作が小さいので横に収まる）。補足（sandbox の状態）は名前の下に小さく出す
- 部品は小さく、飾りを減らす: on / off はスイッチ、2 択（言語・送信キー）は小さな segmented control、上限の数値は狭い入力欄。行の高さは詰め、項目ごとの枠は付けない（節の中は細い区切り線だけ）。上限は 4 行を名前・数値の列で揃え、既定値は入力欄のプレースホルダに出す（既定値のままなら空欄。空欄で適用すると既定値に戻す）。その下の右に「既定に戻す」「無制限」「適用」を並べる
- ポップアップ（シート）は、スマホではつまみ付きで下から開き（下へのスワイプでも閉じる。高さは `80dvh` まで）、PC では画面中央のモーダルとして開く（背景を暗くし、背景のクリックか Esc で閉じる）
- 会話の一覧の各項目の「⋯」から、名前の変更・ピン止め・タブの固定（固定 / 解除）・削除（今の会話以外）を行う。名前の変更は `/rename #<番号> <名前>` を送る
- 会話の一覧の項目の補足の行に「固定」「現在」の文字を出さない。ピン止めはピンのアイコン、今の会話は項目の強調で示す

ログ:

- 人間の入力、各 Agent のターン、Agent 間の message、通知、エラー、コマンドの出力を時系列に並べる
- 人間の入力の発言には、その入力を処理したターンが中断（`interrupted`。`/interrupt`・Ctrl+C・中断のボタン）で終わったら「中断」の印を付ける。配送前に取り消した入力は発言ごと消す（§28「送信の取り消し・編集」）。割り込み（steer）で足した入力は、足した先のターンが中断で終わったら同じ印を付ける
- Agent のターンは 1 つの枠に、tool 呼び出しをまとめた「作業」と、発言を起きた順に並べる。Agent の発言は人が読むものとして扱い、畳まない（途中の発言に人に読んでほしいこと〔見つけた原因・自分で決めたこと・検査の結果〕が多く、畳むと埋もれるため）
  - **発言**: ターンの中の発言（`text`）はすべて Markdown の本文として全文出す（長さで切らない）。発言の間は段落の間隔で分ける
  - **作業**: 枠の tool 呼び出しをすべて、枠の先頭の 1 つの「作業 N 件」に起きた順にまとめて畳む（既定は畳む。上部の「詳細」で一括して開閉）。発言の間ごとに「作業」を挟むと読みにくいため。tool が無ければ出さない。message・質問を送った Clodex の tool（`send_message`・`ask_user`）はカードで見せるので作業に入れない
  - **今の作業**: 作業中だけ、直近の tool を 1 行で出し、新しいものが来たら同じ行を書き換える。経過時間を添える。完了したら消す
  - **最終応答**: ターンの最後の発言と同じなので、二重に出さない（最後の発言がそのまま最終応答になる）。最終応答が最後の発言と違えば、末尾に発言として足す
- 作業中のターンの枠は、ログの一番下に置く（起動中の行や、動いている subagent の行と同じ置き方）。作業中に届いた人の入力・相手の message・通知などは、その枠の上に並ぶ。両方の Agent が作業中なら、始めた順に一番下に並べる。一番下の並びは、作業中のターン → 起動中の行 → subagent の行
  - ターンが終わったら、その時点のログの末尾に枠ごと置く（以後は動かない）。ログはターンが終わった順に並び、時系列を保つ。最終応答を別の項目に分けたり、項目の間を跳ぶボタンを置いたりはしない
  - 一番下に置くのは表示だけ。保存する feed は event の順のまま（読み込み直しても同じ並びになる）
- Agent がターンの中で formal message（`ACK` を除く）を送ったら、その message はそのターンの枠の本文として出し、ログに別の項目として並べない（「依頼しました」の最終応答と message の行が二重に並ばないように）
  - 枠の本文は message のカード（送信元 → 宛先・種類・taskId・本文・spec・関連ファイル・指摘・相手に渡した全文）。複数送ったら送った順に並べる
  - 関連ファイル（`files`）は、3 件までは今どおり並べ、4 件以上は最初の 3 件と「他 {n} 件」（押すと全部を出す）に畳む。スマホでも 1 件ごとの行は詰めて並べる（押せる高さは保ちつつ、1 件で 44px を取らない）。spec は畳まない
  - 最終応答は今どおり時系列の最後の発言として出す
  - Coordinator がターンの最終応答から作った自動の `RESULT` / `ANSWER`（`auto`）も、元のターンの枠の本文にする。そのときは最終応答（最後の発言）を出さない（同じ内容が二重に並ばないように）
  - 送ったターンがログに無いとき（再起動後の復旧で配送し直した message など）は、今どおり別の項目として並べる
  - 作業中のターンで message を送ったら、そこでターンの枠を区切る。そこまでの枠（発言・作業・message のカード）は、その時点のログの末尾に固定し（状態は出さない）、続きの作業は新しい枠として一番下で続ける。作業中の枠は一番下に置くので、区切らないと、送った質問や依頼が、後から届いた相手の回答より下に出てしまうため
    - 続きの枠の見出しは Agent 名と状態だけ
    - 区切った後に作業（発言・tool）も message も無いままターンが終わったら、続きの枠は出さず、最終応答は最後に固定した枠の末尾に発言として入れる（依頼して終えるターンが 1 つの枠にまとまるように）
    - 続けて message を送り、その間に作業が無ければ、同じ枠に並べる（区切りを細かくしない）
- 人への質問（`ask_user`）も、formal message と同じくそのターンの枠の本文に出す（質問のカード: 質問・選択肢・回答待ち / 回答。ログに別の項目として並べない）。区切り・送ったターンが無いときの扱いも message と同じ。回答は同じカードに出す
  - 質問の前後の発言は、ほかの発言と同じく時系列のまま本文に出る（直前の発言は質問の意図を、質問の後の最終応答は選択肢を比べるための案の中身を書いていることが多い）。質問で枠を区切った後に作業が無いままターンが終わったら、最終応答は質問の枠の末尾（質問のカードの下）に入る
- Agent の応答・Agent 間の message の本文・人間の入力は GFM（GitHub Flavored Markdown）として表示する。解析は自前で書かず `marked` を使い、Web UI と TUI で同じ解析結果を使う
  - 対象: 段落、改行（単独の改行も `<br>` にする。`breaks: true`）、見出し、太字・斜体・取り消し線、インラインコード、コードブロック、箇条書き・番号付きリスト（入れ子を含む。書かれた番号から始める）、引用（`>`）、表、区切り線、リンク
  - 生の HTML は描画せず、文字としてエスケープして表示する（Agent や人の入力に `<script>` などが混ざっても実行しない）。リンクは `http:` / `https:` だけをリンクにし、新しいタブで開く（`rel="noopener noreferrer"`）。それ以外の URL は文字のまま
  - `marked` はクライアントの bundle に含める（§17 の「クライアントの組み立て」）
- Agent 間の message は、送信元 → 宛先、種類、本文、関連ファイル、指摘（severity 付き）、相手に渡した全文（畳む）を表示する
- Agent の質問（§12 `ask_user`）は、未回答のものをログの外の「質問欄」に出す。質問欄は入力欄の上にくっつけて置き、ログのスクロールに影響されない
  - 出すのは state の未回答の質問（`questions`）の最も古い 1 組。1 組の中の質問は 1 問ずつ出す: 見出し・質問文・選択肢のボタン（説明を添える。`recommended` は label の横に星のアイコン。`multiSelect` はチェック）・「その他」の入力欄
  - 単一選択の選択肢を押したら、次の未回答の質問へ進む。複数選択と「その他」は「次へ」で進む（「その他」は Enter でも進む）。「前へ」と、質問ごとの点（回答済みかを示す）で前の質問に戻れる。回答は 1 組まとめて送るので、すべて答えたら「回答」を押せる
  - 見出しの行に Agent・何問目か（`1/3`）・ほかに待っている組の数を出す。見出しの行を押すと質問欄を畳む／開く（畳むと見出しの行だけ）。スマホでも畳んでログを見られる。開いているときの高さは画面の半分までにし、超えたら質問欄の中でスクロールする
  - 回答の下書き（選んだもの・入力・何問目か）は組ごとに画面で持ち、畳んでも消えない
  - ログには、未回答の質問は「回答待ち」の 1 行だけを出す。回答したら、質問ごとに質問文と回答を並べた記録にする
  - 件数の pill は出さない
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
- 再接続の帯にはスピナーを付ける。再接続をあきらめた（EventSource が閉じた）ら「再読み込み」ボタンに変える。再接続した直後はログを消さず、届いた履歴で差し替える。同じ会話のまま再接続したときは、上に読み足した古い履歴を残し、読み返している位置も保つ（スマホでアプリに戻るたびに読み返していた場所を失わない）
- そのほか: 前の履歴を読んでいる間はログの先頭に読み込み中の行、画像のアップロード中は添付の縮小画像にスピナー（終わるまで送信できない）、`!command` の実行中は出力の頭に経過時間

使い勝手の決まり:

- **ページの横スクロールを発生させない**。長いコマンド・JSON・全文は折り返す。表だけはブロックの中で横スクロールし、端の影でスクロールできることを示す。長いコードブロックは高さを抑えて畳み、「全文」で開く
- 読み返している間に新しい項目が来ても勝手にスクロールしない。一番下にいないときは、ログの右下に最新（一番下）へ跳ぶボタンを出す。文字は出さず下矢印のアイコンだけにし、`aria-label` と title を付ける（ja「最新へ」/ en "Latest"）。読み返している間に新しい項目が来たら、ボタンに小さな点を付ける。押すと一番下へスクロールし、ボタンを隠す
- 入力: PC は既定で Enter で送信（Shift+Enter で改行）。設定の「送信キー」で「Ctrl+Enter で送信」（Enter と Shift+Enter で改行）に切り替えられる。設定は端末ごとに localStorage に保存する（PC とスマホでキーボードが違うため）。スマホは設定によらず Enter で改行し、送信はボタン（日本語入力の確定と誤送信を防ぐ）。判定は 1 つの純関数にする
- 候補（`/`・`@` のサジェスト）が出ていても、Enter は候補を確定せず入力の扱い（送信か改行）のまま。候補の確定は Tab だけ、選ぶのは ↑↓、閉じるのは Esc（TUI も同じ）
- 入力欄の文字は本文と同じ大きさにする。iOS が入力欄のフォーカスで画面を拡大しないよう、スマホの入力欄は 16px にする
- 送り先は入力欄の切り替えで選ぶ（既定は primary）。`/`・`@`・`!` で始まる入力はそのまま送る（`!command` も terminal と同じく実行する）
- 開いているシート（Agent の操作・設定）は、`state` が届いたら表示中の値だけを更新する。DOM を作り直さない（タップ中のボタンを差し替えない）
- 作業中のターンは、event が来たら変わったところだけ更新する（増えたステップを足す・変わった本文だけ描き直す・画像のプレビューは同じパスなら使い回す）。ターン全体を作り直さない（長いターンやスマホで重くならないように）。ブラウザが持つ履歴は、表示する項目と同じ上限（1500 件）で古い方から切る
- 接続が切れている間はその旨を表示し、自動で再接続する。TUI も同じく、Hub との接続が切れたら通知の行に出し、間隔を伸ばしながら再接続する（黙って止まらない）
- ログ全体は読み上げの対象（`aria-live`）にしない。経過時間の更新や作業中のターンの描き直しを読み上げ続けないため。ターンの完了と人への質問だけを、画面に出さない読み上げ用の領域で読む
- `toast` は画面の上部（PC は右上）に重ねて出し、4 秒で消す。押すとすぐ消す。同時に出すのは 3 件まで（古いものから消す）。`warn` は警告色。通知（`notify`）の toast は、タイトルを 1 行目、本文を 2 行目に分けて出す。TUI は下の固定部分の通知の行に 4 秒出す
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
  - session も title も無い会話は保存しない。ピン止めした会話を先頭に、それ以外を新しい順に最大 20 件残す（ピン止めとタブに固定した会話は枠に数えない。タブが指す会話を消さないため）
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
- `interrupted` の Agent ごとに、そのターンの方針（最初の発言の 1 行目）と、最後の数件（5 件まで）の tool 呼び出し（名前と入力の要約）を `lastWork` として残す。復旧の続きの指示（`RECOVERY_CONTINUE`）に `Before the restart you were: <方針>. Last actions: <tool の一覧>.` を添え、途中の状態を確かめ直す手間を減らす
- 配送待ちが変わるたび・ターンが始まる・終わるたびに書き直す（異常終了でも直前の状態が残る）。戻す作業が 1 つも無い会話は書かない
- 保存に失敗しても Hub を止めない（次の変化で書き直すので、1 回の失敗では作業を失わない）。失敗は最初の 1 回だけ stderr に出し、保存に成功したら次の失敗をまた出す
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

# 19. MCP Manager

各 CLI（Claude Code / Codex CLI / Antigravity CLI）が使う MCP サーバーの設定を Clodex で一元管理する。**設定同期型**: Clodex は各 CLI の設定ファイルに登録を書き込むだけで、ツールの実行・認証は各 CLI に委任する（Clodex が中継・ホスティングはしない）。元の提案は `docs/specs/Clodex_MCP_Manager_Design.md`。

## 内部モデル

- 置き場所は既存の設定と同じ 2 層: グローバルは `~/.clodex/config.json`、プロジェクトは `<root>/.clodex.json`。どちらも `mcp.servers` キーに入れ、同名はプロジェクトが優先する（§13 Native configuration と同じ重ね方）
- サーバーの形: `{ transport: "stdio" | "http", command?, args?, url?, env?, envRefs?, enabled, agents: { claude, codex, gemini } }`。`agents` で CLI ごとの適用を切り替える
- `env` は秘密でない値のみ。API キーなどは `envRefs`（環境変数名への参照）で渡し、平文では保存しない。CLI が環境変数の展開に対応しない組み合わせは警告し、黙って省略しない
- サーバー名 `clodex` は予約（Coordinator の formal message 用 MCP。§12。Manager からは登録・編集できない）

## 同期（CLI アダプター）

- 各 CLI の設定の読み書きは Adapter ごとに分け、**実測した**設定ファイルの場所・スキーマ・公式コマンドだけを使う（`docs/spikes/mcp-manager.md`）
- 既存の設定を全置換しない。Clodex 管理対象（内部モデル由来）だけを差分更新し、CLI 側にだけある登録は「外部管理」として一覧に表示する（読み取りのみ）
- 書き込みの前に対象ファイルを読み直して差分（プレビュー）を人に見せ、適用時はバックアップを取り atomic に書く
- CLI が対応しない項目（トランスポート・スコープ・環境変数の展開など）は、その CLI の列に「未対応」と出す
- Antigravity は headless だと承認待ちのツールを denied にしてターンを打ち切るため、gemini に同期するサーバーは `~/.gemini/antigravity-cli/settings.json` の `permissions.allow` に `mcp(<名前>/*)` を併せて書く（削除時は取り除く。`mcp(clodex/*)` は §12 の予約で触らない）
- 反映は各 CLI の次回起動から。接続・認証の成否は取得できないため、状態は設定の一致だけで判定する（`同期済み / 未設定 / 不一致 / 未対応 / 外部管理`。接続状態は「未確認」）

## 画面

- Web UI にサーバーの一覧・編集・Agent 割り当て・適用プレビューのシートを置く（§17 Web UI）。設定の変更は内部モデルに保存し、適用（同期）は明示の操作で行う

## 対象外（初期版）

- Clodex 自身による MCP ツールの実行・中継、OAuth 認証フローの代行、MCP サーバーのホスティング
- 特定サービス（Google Sheets 等）専用の UI・API

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

# 25. Agent Communication Limits

Agent 同士の runaway conversation を禁止する。

- 上限は §14（chain 単位の hard limit）
- `ACK` は配送しないので、`ACK → ACK → ACK` の往復は起きない（§12）
- 返信を求めるのは依頼系の message だけ（§13）
- message ID は Coordinator が採番するので、重複受信は起きない。再送（§11 配送ルール）は同じ message を送り直し、再送であることを envelope に添える

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
| 会話のリネーム・削除・ピン止め | `/rename [#<番号>] <title>`（番号を省略すれば今の会話。名前が数字で始まっても番号と取り違えないよう `#` を付ける）、`/delete <番号>`、`/pin <番号>`（もう一度で解除）。ピン止めした会話は一覧の先頭に出し、最大 20 件の枠から外す。今の会話は削除できない。削除した会話の feed も消す。Web UI は会話一覧の項目のメニューから送る |
| 送信の取り消し・編集 | まだ配送していない人間の入力は取り消せる。Web UI は配送待ちの入力に「取り消し」「編集」を出す（編集は取り消して本文を入力欄に戻す）。CLI は `/cancel` で最後の配送待ちの入力を取り消す。配送済み（Agent が処理中）の入力は取り消せないので、`/interrupt` を使う。state に配送待ちの入力（ID・送り先・本文）を含める。配送待ちの formal message も同じ一覧に出し、`/cancel <message ID>` で取り消せる（下記「上限での停止と自動再開」）。取り消した入力・message は会話のログに残さない（送った時点でログに出ていれば消す。保存する feed・`read_conversation` の本文からも除く）。取り消しの知らせはログに入れず、`toast` だけにする（TUI も同じ） |
| `/interrupt` で Agent 間のやり取りを止める | Agent 指定なしの `/interrupt` は、実行中のターンと `!command` に加えて、配送待ちの formal message を破棄し、進行中の chain を閉じる（以後その chain の `send_message` は拒否）。人間の配送待ちの入力は残す（取り消しは上の操作で行う） |

### B — 成果物のプレビュー

- 会話で扱ったファイルを 2 つに分け、画面上部の別々のボタン（「資料」と「成果物」）から開くシートに並べる（それぞれ新しい順、同じパスは 1 つ）。一覧は画面が feed から組み立てる（サーバーに状態を持たない。保存した feed から復元した会話でも出る）
  - **資料**: Agent が人に見せるために出したもの。Agent の最終応答と formal message の本文に書かれたファイルのパス（Markdown のリンク `[名前](<パス>)` と、絶対パス）、formal message の `spec`、本文に書かれた画像のパス（png / jpg / jpeg / gif / webp）。作業の途中の発言は対象外
  - **成果物**: 作業中に扱ったファイルのうち、資料に無いもの。変更は tool event の `files`（Claude の Edit / Write / MultiEdit / NotebookEdit の `file_path`（`notebook_path`）、Codex の `fileChange` の `changes[].path`）、参照は formal message の `files`
  - 資料のボタンは、項目が無い会話でも出す。その会話で最後に資料のシートを開いた後に新しい資料が出たら、ボタンに小さな点を付ける（開くと消える。最後に開いた時刻は会話ごとに端末の localStorage に持つ。一度も開いていない会話は、資料が 1 つでもあれば点を付ける）
  - 人に見せたいファイルは最終応答に `[名前](<フルパス>)` で書くよう、役割の定型文で伝える（画像と同じ）
- 選ぶと中身を表示する。変更したファイルは、最初から差分を git の差分の形で見せる（追加の行は緑・削除の行は赤の背景、`@@` の区切りの行は控えめな色、行の先頭の `+` / `-` を残す）。「全体」で中身の表示に切り替えられる。変更していないファイルは中身（Markdown は §17 の簡易描画）、画像はそのまま表示する
  - 差分は、その会話でそのファイルに最初に触れた時点からの変更: その時刻より前の最後のコミット（`git rev-list -1 --before=<時刻> HEAD`）と今の作業ツリーの差（`git diff <commit> -- <path>`）。コミット済みの変更と未コミットの変更をまとめて出す。その時刻より前のコミットが無ければ空の木との差、未追跡のファイルは全行を追加として出す。変更が無ければ「変更なし」と出し、中身を表示する
  - 画面は最初に触れた時刻を feed の event の時刻から求め、`GET /api/diff?path=&since=<ISO 8601>` で取る（`since` が無ければ今どおり `git diff HEAD`）
- 会話の中でも画像を見せる（Web UI）。Agent の最終応答、formal message の本文、人間の入力に書かれた画像のパス（上の「画像」と同じ判定）を、本文の下にサムネイルとして並べる（同じパスは 1 つ）。`GET /api/file` で読み、読めない（範囲外・存在しない）ものは出さない。選ぶとビューアで開く。作業の途中経過（steps）と plan には出さない
  - サムネイルは小さく控えめにする（高さ 96px・幅 160px まで）。複数の画像があっても本文の下が埋まらないように。中身はビューアで見る
  - サムネイル・本文のパス・ビューアの画像の URL には、そのメッセージの時刻を `v` として付ける。同じパスの画像が書き換わったとき、ブラウザがページ内で前の画像を使い回さないように
  - 本文に書かれた画像のパス（サムネイルと同じ判定。インラインコードの中も含む。リンクの中は除く）も、クリック（キーボードは Enter）でビューアを開けるようにする。見た目は本文のリンクと同じ色（`--link`）と実線の下線、拡大のカーソル。本文にはファイル名だけを出し、フルパスは `title` に持たせる。サムネイルが読めなかったパスはリンクにしない。本文をパスとそれ以外に分ける処理は純関数にする
  - 画像のビューアは、テキストのシートとは別の全画面の表示にする（暗い背景に画像をウィンドウに収めて出す）。拡大縮小はホイール・ピンチ・ボタン（縮小・倍率・拡大・全体）、`+` / `-` / `0` のキー。ダブルクリック（タップ）で全体と等倍を切り替える。拡大中はドラッグで動かす。倍率は 0.1〜8 倍。上の帯にファイル名だけを小さく出し（フルパスは `title`）、元の画像を新しいタブで開くボタンと閉じるボタンを置く。Esc・背景のクリックで閉じる
  - 拡大縮小の計算（全体表示の倍率と位置、指した点を動かさない拡大）は純関数にする
- 本文の Markdown のインラインコードのうち、絶対パス（`C:\` / `C:/` / `~/` で始まるもの、`/` で始まり区切りが 2 つ以上あるもの。`/limits` のようなコマンドは含めない）は、ほかのインラインコードより小さく控えめな色にする（パスが本文より目立たないように）。ほかのインラインコードと同じく、長ければ途中で折り返す（スマホでログが横にずれないように。class 名は画面の別のパス表示と分ける）
- Agent が証跡として見せたい画像（スクリーンショット等）は、`~/.clodex/artifacts/<project 名>/` に保存して本文にフルパスを書くよう、役割の定型文で伝える（project の working tree を汚さない）。定型文には、表示される書き方（フルパスをそのまま、または `[名前](<フルパス>)`）と、発言（最終応答を含む）か `ask_user` の質問文に書けば画面に出ることを書く
- 画像のパスをプレビュー（本文の中のクリックできる名前と、下の縮小画像）にする範囲: ターンの発言（最終応答を含む）・人の入力・Agent 間の message・質問欄の質問文と選択肢の説明・ログの質問の記録
- Markdown の画像記法 `![説明](<パス>)` は、パスを本文の文字として残す（画像として埋め込まない。パスがプレビューになる）
- API: `GET /api/file?path=` と `GET /api/diff?path=`（token 認証）。読めるのは project root と上の artifacts ディレクトリの中の通常ファイルだけ（`..` や symlink で外に出ない。実パスで確かめる）。大きさの上限はテキスト 2 MB、画像 10 MB

### C — 割り込みとマルチエージェント

実測: docs/spikes/steer-image-subagent.md

割り込み（steer）:

- Adapter の `steer(text)`: 実行中のターンに指示を足す。Claude は実行中に stdin へ user message をもう 1 行、Codex は `turn/steer`（`expectedTurnId` = 実行中の turn）。どちらも新しいターンにはならず、実行中の tool / command の区切りで取り込まれる。足せなかった（実行中でない、Codex の turn ID が未確定、`activeTurnNotSteerable` 等）ら false を返す
- 人間: `@claude! <text>` / `@codex! <text>`。その Agent が実行中なら steer し、そうでなければ（steer できなければ）通常の送信としてキューに積む。人間の入力の event に `steer: true` を付け、画面は「割り込み」と出す
- 送信待ちから: `/steer <id>`（Web UI は送信待ちの一覧の各行の「割り込み」。人間の入力・formal message の両方）。配送待ちの項目を mailbox から外し、宛先の実行中のターンに steer する。人間の入力は `@<agent>!` と同じ扱い（ログの発言に「割り込み」と届いた印を付ける。新しい発言は足さず、送ったときの発言を割り込みに変える）、formal message は `interrupt: true` と同じ扱い（Task envelope に `Interrupt: yes`、画面に「割り込み」）
  - 宛先が実行中でない・steer できなかったら、項目は送信待ちの元の位置に残し、`toast`（warn）で「{agent} は作業中でない」などと知らせる（失敗の理由に合わせて短く）。利用枠の上限で待っている宛先も steer しない
  - steer に対応しない Agent（Gemini。agy の headless に実行中のターンへ足す手段が無い）と、新しい session で届ける（`fresh`）message は割り込めない。Web UI はその行の「割り込み」を押せなくし、`/steer` は理由（「{agent} は割り込み非対応」「新しい session の依頼は割り込み不可」）を返す。Agent ごとの対応可否は registry（§28 G1）に持つ
  - 成功の知らせは出さない（ログの発言の「割り込み」で分かる）
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
- 動いている subagent を画面に出す。本体のターンが終わって Agent が待機中になっても、裏で subagent が動いていれば分かるようにする（本体の状態は今どおり待機中のまま）
  - Adapter は動いている subagent の一覧が変わるたびに `subagents` event（`{ running: Array<{ id; description }> }`。そのときの全件）を出す
    - Claude: `system/background_tasks_changed` の `tasks` のうち `task_type: "local_agent"` のもの（`id` は `task_id`、`description` は `description`）。subagent が動かす Bash などの task（`local_bash`）は数えない（docs/spikes/claude-subagent.md）
    - Codex: 親の thread の `subAgentActivity` の `started` で足し、`completed` で外す（`id` は `agentThreadId`、`description` は `agentPath`）（docs/spikes/steer-image-subagent.md）
    - プロセスが終わったら（停止・異常終了・`/new` などの起動し直し）空の一覧を出す
  - Coordinator は Agent ごとに最新の一覧を持ち、state の `AgentState.subagents` に入れる。保存はしない（Hub を再起動したら消える。CLI のプロセスも作り直すため）
  - Web UI: Agent ストリップのカードとスマホの Agent ピルに、動いている subagent があるときだけ印（アイコンと数）を出す。印はその Agent の色で塗り、作業中の表示と同じ調子でゆっくり明滅させる（`prefers-reduced-motion` では動かさない）。title に各 subagent の説明を並べる。スマホの Agent のシートには説明の一覧を出す
  - ログの末尾: Agent が作業中でなく、動いている subagent があるとき、ログの一番下（起動中の行と同じ置き方。保存しない表示だけの行）に Agent ごとの行を出す。Agent の mark・名前・回る印・「サブエージェント {数}」と、説明を 1 行ずつ。subagent が無くなるか Agent が作業を始めたら消す（作業中のターンの枠が出るため）
  - TUI: 下の行の Agent の状態に、動いている subagent の数を添える
- 裏で動いているコマンド（background task）も subagent と同じ置き方で画面に出す。Agent がコマンドを裏で動かして完了を待つ間、本体は待機中になり、コマンドが動いているのか分からないため（実測: docs/spikes/background-task.md）
  - Adapter は動いている background task の一覧が変わるたびに `background_tasks` event（`{ running: Array<{ id; description }> }`。そのときの全件）を出す。対象と取り方は実測で決める（Claude は `run_in_background` の Bash の `local_bash`。subagent が動かすものは数えない。Codex は裏で動く端末があれば）
  - state の `AgentState.backgroundTasks` に入れる（保存しない）。画面は subagent と同じ（Agent のカード・ピルの印はアイコンを変えて別に出す。ログの末尾の行は「バックグラウンド {数}」と説明を 1 行ずつ。subagent と両方あれば 1 つの行に並べる）。TUI は数を添える


画像の貼り付け:

- Web UI で画像を貼り付け・選択すると `POST /api/upload`（token 認証、10 MB まで、png / jpeg / gif / webp）で `~/.clodex/uploads/<project 名>/` に保存する。パスは入力欄の文字に入れず、入力欄の枠の中・文字の上に縮小画像として並べる（Claude デスクトップの添付と同じ形）
  - 縮小画像は角丸の正方形（PC 64px、スマホも同じ）。右上に「×」（削除。`aria-label`・title「削除」。押せる範囲はスマホで 44px）。押すと添付から外す（保存したファイルは消さない）。縮小画像を押すと成果物と同じ lightbox で開く
  - 貼った直後から手元の画像（object URL）で縮小画像を出し、保存が終わるまでは縮小画像の上にスピナーを重ねる。保存中は送信できない。保存に失敗したら縮小画像を外し、今どおり toast を出す
  - 送信するときに、添付のパスを `@<パス>` として本文の末尾に足す（本文と添付は改行で分け、添付どうしは空白で分ける）。添付があれば本文が空でも送れる。送信に成功したら添付を空にする
  - 添付は下書きと同じく会話ごとに端末に保存する（会話を切り替えても、読み込み直しても残る）。戻したときの縮小画像は保存先のパスのプレビューを使う
  - 送信待ちの入力の「編集」で入力欄に戻す本文は今どおり文字のまま（`@<パス>` を添付に戻さない）
  - 入力欄の上の「アップロード中」のチップは出さない（縮小画像のスピナーで示す）
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
- 同じ会話の ConversationRuntime、同じ project の ProjectContext を作る要求が重なっても（スマホと PC からの同時操作など）、作るのは 1 つだけ。作成中のものがあればその完了を待って共有する。作成に失敗したら、次の要求で作り直す
- 人が見ている会話（**今の会話**）は 1 つ。terminal と Web UI は今の会話の event を表示し、入力・`/status`・`/interrupt`・`/cancel`・`/compact` 等は今の会話に対して行う
- `/resume <番号>` は今の会話を切り替えるだけで、前の会話の Agent は止めない（作業中なら続ける）。`/new` は新しい会話を今の会話にする
- 今の会話以外で Agent のターンが終わったら、`toast` で知らせる（例: `「設計の相談」の codex のターンが終わりました（completed）`。ログには入れない。§17）
- feed は会話ごとに保存する（今と同じ）。今の会話でない間の event も保存する
- **worktree**: `/new worktree` で、新しい会話用の worktree を作ってその会話の作業場所にする（`git worktree add <project の隣>/<project 名>-<会話の短い ID> -b clodex/<会話の短い ID>`）。会話の履歴に作業場所（`workDir`）とブランチを記録し、`/resume` で戻ったときもそこで Agent を起動する。worktree の削除・マージは人が git で行う
- **既存の会話を worktree に移す**: `/worktree`（Web UI は会話のメニューの「worktree に移す」も）で、今の会話用の worktree を `/new worktree` と同じ名前で作り、その会話の作業場所にする。会話の履歴の `workDir` とブランチを書き換え、起動している Agent は今の session を新しい作業場所で resume して続ける（docs/spikes/worktree-resume.md）。起動していない Agent は次に起動したときに新しい作業場所で始まる
  - worktree は HEAD から作る。project の未コミットの変更は持ち込まない（project に残る）
  - すでに worktree で作業している会話では使えない（「worktree で作業中」）。どちらかの Agent が作業中・配送待ちがあるときも使えない（「先に /interrupt」）
  - 移った先から project や別の worktree へ戻す操作は作らない
- 設定ファイルの `worktree.setup`（例: `"pnpm install"`）があれば、worktree を作って切り替えた直後（`/worktree` で移した直後も）に、その worktree で `!command` と同じように実行する。git が持たない依存関係（`node_modules` など）が無いと、worktree でテストが通らないため。出力は `!command` と同じに表示し、Ctrl+C や `/interrupt` で止められる。終わるのは待たない
- 同じ作業場所で別の会話の Agent が作業中のときに入力したら、`/new worktree` を勧める `toast` を出す（止めはしない）
- Web UI の会話の一覧に、各会話の状態（作業中・待機中・停止中）と worktree の印を出す
- **子の会話で並列に受ける**（`send_message` の `parallel`）: 作業中の Agent に独立した依頼を渡すとき、ロール文で「メインは待機し、作業はサブエージェントで」と書くと、親が subagent の完了を待ち続けて同じコンテキストを二重に読む。Clodex が同じ Agent を別の会話で動かし、並列に受けさせる
  - 受け付けたとき宛先が作業中か、`worktree: true` なら、同じ project に子の会話を作る（今の会話は切り替えない）。子の会話の履歴に親（会話 ID・依頼の message ID・送信元・宛先）を記録する。作業場所は、`worktree: true` なら新しい worktree（`/new worktree` と同じ名前の付け方）、そうでなければ親の会話と同じ作業場所。名前は「{taskId}（並列）」
  - 子の会話の runtime を作り、宛先の Agent を新しい session で起動して、依頼の envelope を届ける（Task envelope に `Parallel: yes (a separate conversation; your other work continues elsewhere)` の 1 行）
  - 子の会話の Agent が相手の Agent に送る formal message（`QUESTION`・`RESULT`・`ISSUE` など）と自動の `RESULT` / `ANSWER` は、子の会話の相手の Agent ではなく、親の会話の送信元へ届ける。親の会話では message に `thread`（子の会話 ID）を付けて出し、画面は message のカードに「並列: {子の会話名}」の印（押すと子の会話へ切り替える）を出す
  - 親の会話から `thread` のある message への返信（`ANSWER` など。`replyTo` で判定）は、子の会話の宛先へ届ける。子の会話の相手の Agent は起動しない
  - Budget は親の会話の chain で数える（子の会話から届いた message は、親の依頼の chain の続き）
  - 子の会話は会話の一覧に出さない。親の会話の message のカードの「並列」の印から開く（開いている間はタブに出してよい）。保存する会話の上限（20 件）に数えない。親の会話を消したら、子の会話も一緒に消す。worktree のマージ・削除は人が行う
  - 片付け: 子の会話の宛先が、親の依頼への `RESULT`（自動の `RESULT` を含む。`replyTo` が親の依頼の message）を送り、そのターンが終わって子の会話に配送待ちが無くなったら、子の会話の Agent を止める（runtime は残す。止めた後に親から返信が来たり、人が子の会話に入力したりしたら、今どおり resume して起動する）。並列の依頼のたびに Agent のプロセスが残り続けないように
  - 人は子の会話を開いて、その Agent に直接入力してもよい

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
  - 裏で動いている会話（今の project の今の会話以外。ほかの project の会話はその project の今の会話も含む）の Agent のターンが終わったときと、Agent が人に質問（`ask_user`）したときも、今の会話と同じ通知を出す（下記「通知の形式」。GUI の Windows 通知・Web Push・画面の toast）
  - `/project` で開いている project の一覧、`/project <path>` でその project を開いて今の project にする（path は resolveProjectRoot と同じ規則で解決する）。Web UI は上部に project の切り替えを出し、`/project <path>` を送る
  - 開いた project の一覧は `~/.clodex/hub.json` に保存し、次の起動で一覧に出す（開くのは選んだとき。ただし復旧する作業がある project は起動時に開く。§18）
  - **一覧の整理**: `/project pin <path>` でピン止めを切り替え、`/project remove <path>` で一覧から外す。path は一覧にあるものをそのまま指定する（フォルダが消えていても外せるよう、resolveProjectRoot では解決しない）。ピン止めは `hub.json` の `pinned` に保存する
    - 一覧はピン止めした project を先に、ほかを後に並べる（それぞれ開いた順）
    - 開いている project（今の project を含む）は外せない。外すと Agent を止めることになるため。外した project も `/project <path>` で開けば一覧に戻る
    - Web UI の project のセレクトは、ピン止めを「ピン止め」の optgroup にまとめ、最後に「一覧を編集…」を置く。選ぶとシートを開き、project ごとにパス・ピン止めのトグル（pin のアイコン。`aria-pressed`）・外すボタン（開いている project には出さない）を並べる
  - **タブ**: プロジェクトをまたいで会話を切り替えるタブを出す。タブに出すのは、開いたことのある全プロジェクト（`hub.json` の一覧）の会話のうちタブに固定したものと、今の会話
    - **タブの固定は会話の一覧のピン止めと別**。ピン止めは会話の一覧の並び（先頭に出す）と保存の枠の扱い、タブの固定はタブに残すかどうか。一方を変えても他方は変わらない。会話の保存に `tabbed`（boolean）を持つ（`pinned` と同じ置き方）。`tabbed` の無い保存は `pinned` の値をタブの固定の初期値にする（分ける前はピン止めがタブだったため）
    - 固定していない今の会話のタブは 1 つだけで、ほかの会話に移ると消える。固定したタブは、ほかの会話・ほかのプロジェクトの会話を開いても残る
    - 並びは、プロジェクトの一覧の順（ピン止めしたプロジェクトが先）、その中は会話の一覧の順。今の会話が固定していないものなら末尾
    - タブの中身: プロジェクト名（フォルダ名）・会話名・作業中の印（開いているプロジェクトの会話だけ。開いていないプロジェクトは Agent が動いていない）。今の会話のタブは選ばれた見た目にする。固定したタブには × を出し、押すとタブを閉じる（固定を外す。ピン止めは変えない）。固定していない今の会話のタブには固定のアイコン（pin。`aria-label`・title「タブを固定」/ "Keep tab"）を出し、押すと固定する（まだ保存されていない新しい会話には出さない。空の会話を固定しても使い道がないため。最初の入力を送れば保存されて出る）
    - 押すと `/tab <会話 ID> <project root>` を送る。Hub はそのプロジェクトを今のプロジェクトにして（開いていなければ開く）、その会話に切り替える。固定は `/tab keep <会話 ID> <project root>`、× は `/tab close <会話 ID> <project root>`
    - 開いていないプロジェクトの会話は、保存してある会話の一覧（`.json`）から読む（プロジェクトを開かない。Agent を起動しない）。タブを閉じるときも、開いていなければ保存してある一覧を書き換える
    - state に `tabs`（`{ projectRoot, conversationId, title, tabbed, current, activity? }` の配列）を入れる。会話の一覧の項目にも `tabbed` を入れる（「⋯」のメニューの表示に使う）
    - 置き場所: PC はヘッダの下（右の列の上端）に横に並べ、収まらなければ横にスクロールする。スマホはヘッダの下に横にスクロールする帯にする。タブが今の会話 1 つだけのときも出す（場所が動かないように）
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
- **通知の形式**: GUI の Windows 通知・Web Push・画面の toast は、今の会話・裏の会話・ほかの project の会話で同じ形式にする。通知は Hub が作り、feed の `notify` の項目（`{ kind, project, conversation, agent?, title, body }`）として流す。GUI と画面はそれを出すだけにする（今の会話の通知も画面では作らない）
  - タイトル: `Clodex【<project 名>】「<会話名>」`（project 名はフォルダ名。会話名が無ければ「（入力なし）」）。英語も同じ形
  - 本文: `<内容>（<Agent 名>）`。内容は種類で変える
    - ターンが終わり、そのターンで tool を使った: 「作業完了しました。」/ "Work finished."
    - ターンが終わり、tool を使わず返答だけ: 「応答しました。」/ "Replied."
    - ターンが失敗した: 「失敗しました。」/ "Failed."、中断した: 「中断しました。」/ "Interrupted."
    - 人への質問（`ask_user`）: 「ユーザの回答待ちです。」/ "Waiting for your answer."
    - 利用枠の上限で止まった: 「利用枠の上限で停止しました。再開 <時刻>。」/ "Stopped at usage limit. Resumes <time>."
    - Agent のエラー: 「エラー: <1 行目>」/ "Error: <first line>"
    - Agent に関係しない通知（利用枠の偏りなどの `notice`）は、本文をその文のままにし、`（Agent 名）` を付けない
  - 今の会話は、今どおり「どの Agent も作業中でなく配送待ちも無い」状態になったときに、最後に終わったターンで 1 回だけ出す。裏の会話・ほかの project は、ターンが終わるたびに出す
  - Agent 同士のやり取りの途中のターンでは、ターンの終わりの通知を出さない。途中のターンは、相手からの依頼（`DELEGATE`・`QUESTION`・`REVIEW_REQUEST`）を処理したターンと、ターンの中で相手に formal message を送ったターン（Coordinator が最終応答から作る自動の `RESULT` / `ANSWER` を含む）。結果は相手の Agent に渡るだけで、人が見る必要が無いため。相手の `RESULT` を受けて人に報告して終えるターン（`ANSWER` を受けて作業を続け、message を送らずに終えたターンも）と、人への質問（`ask_user`）は今どおり出す
    - Coordinator がターンの終わりの event に途中のターンの印（例: `handoff: true`）を付け、Hub は印のあるターンで通知を作らない。今の会話で最後に終わったターンが途中のターンなら、その回は出さない
  - 画面の feed の読み込み（再生）では出さない
- **通知**: Tauri の中の Web UI が、ウィンドウが見えていないかフォーカスが無いときに、Windows の通知を出す（`tauri-plugin-notification`）。ブラウザの Web UI では出さない
  - 出すのは上の「通知の形式」の `notify` の項目
  - 画面を開いたときや会話を切り替えたときの feed の読み込み（再生）では出さない
  - 音は Windows の既定の通知音（plugin は `sound` を指定しないと無音にする）
- **スマホへの通知（Web Push）**: 上の通知のうち、ターンの終わり（作業完了・応答・失敗・中断）と人への質問の `notify` だけを、登録した端末（ホーム画面に追加した PWA。iOS 16.4 以降）に Web Push で届ける。画面を開いていなくても届く
  - 送るのは Hub が作る `notify` の項目（上の「通知の形式」）のうち、ターンの終わりと人への質問の種類だけ。タイトルと本文はそのまま使う。会話の切り替えなどの再生では作らないので、通知しない
  - 送り先から外す: その端末の画面が見えている間（下の `visible`）は送らない。iOS は Push を受けて通知を出さないと購読を取り消すことがあるので、Service Worker では間引かず、Hub が送る前に間引く
  - 鍵: VAPID の鍵は初回に作り `~/.clodex/push/vapid.json` に置く（subject は `https://github.com/HiraG-62/Clodex`）。購読は `~/.clodex/push/subscriptions.json`（`{ id, endpoint, keys }[]`。`id` は endpoint の SHA-256 の先頭 16 文字）。送信が 404 / 410 なら購読を消す
  - API（token で認証）: `GET /api/push/key`（公開鍵）、`POST /api/push/subscribe`（購読。`id` を返す）、`POST /api/push/unsubscribe`（`{ id }`）、`POST /api/push/visibility`（`{ id, visible }`）。Service Worker の `/sw.js` は秘密を含まないので token なしで返す
  - 見えているか: 購読した端末の画面は `/events?push=<id>&visible=<0|1>` でつなぎ、`visibilitychange` で `/api/push/visibility` を送る。Hub は id ごとに、つながっていて見えている接続があれば送らない。接続が切れたら見えていない扱い
  - Service Worker: `push` で通知を出す（タイトルと本文）。通知を押したら開いている画面を前に出し、無ければ `/` を開く
  - 設定画面の「端末」の節の「通知」: スイッチ（`on` で権限を求めて購読、`off` で解除）。Push を使えない画面（`PushManager` が無い。iOS の Safari でホーム画面に追加していないときなど）と GUI の中の画面では出さない。権限が拒否されたり失敗したりしたら toast を出して `off` のままにする
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
  - Hub は GUI の有無と更新の状態を feed の `{ type: "gui", gui: { version, update } | null }` で全画面に送る（接続時と変わったとき）。`update` は `checking` / `latest` / `available`（`version`）/ `installing`（`progress`: ダウンロードの割合 0〜100。分からなければ無し）/ `error`（`message`）。GUI がつながっていなければ状態は消す
  - 設定画面の「Clodex」の節に、GUI の版と更新のボタンを 1 つ出す。GUI がつながっていないときはこの項目を出さない。ボタンの文言と押したときの動きは状態で変える
    - 未確認・最新版・失敗: 「更新を確認」（`check`）。最新版なら版の横に「最新版」、失敗なら「失敗: <message>」を小さく出す
    - 確認中: 「確認中…」（押せない）
    - 更新あり: 「更新 <version>」（`install`）。押したら確認（「Clodex <version> に更新しますか？作業中のターンは止まります」）の後に送る
    - 入れ替え中: 「更新中… <progress>%」（押せない。割合が分からなければ「更新中…」）
  - 画面は `POST /api/gui/update`（`{ action: "check" | "install" }`）を送る。Hub は状態を `checking` / `installing` にし、GUI の接続へ `{ type: "gui_command", action }` を送る。GUI が無ければ 409
  - GUI の画面は Tauri command（`check_update` / `install_update`）を呼び、結果を `POST /api/gui/status` で Hub に返す。`install_update` はダウンロードの進み具合（受け取った量と全体の大きさ）を channel で画面に返し、画面は割合が 5% 変わるたびに `installing`（`progress`）を `POST /api/gui/status` で送る。`install_update` はダイアログを出さずに入れ替える（上の入れ替えと同じく Hub を止めてからインストーラーを起動する）。入れ替え後に GUI と Hub が起動し直し、各画面は再接続で新しい版の画面を読み込む
  - Tauri 2.11.1 以降は、外部 URL の画面（Hub の `http://127.0.0.1`）から app の command を呼ぶには ACL の許可が要る。`build.rs` の `AppManifest` に command を並べ、capability `main` で `allow-check-update` / `allow-install-update` を許可する（`check_update` は新しい版の版か `null` を返す）


D4 の詳細（TUI。D2b と一緒に行う）:

- TUI は Ink（React で端末の画面を組む）で作る。`clodex` を terminal（TTY）で起動したときの既定の画面にする。stdin が TTY でないとき（パイプ入力）は今の行ごとの処理のまま
- TUI は **feed のクライアント**として作る。Web UI と同じく、feed の項目（`event` / `output` / `state` / `reset`）を受け取り、1 行の入力を送るだけ。つなぎ先は 2 通りで、TUI は違いを知らない:
  - **Hub につなぐ（D2b）**: `~/.clodex/hub.lock` の Hub が生きていれば、HTTP + SSE（`/events`・`/api/input`・`/api/files`、token は `~/.clodex/web-token`）でつなぎ、起動した場所の project を `/project <cwd>` で開く。TUI を閉じても Hub は止めない
    - hub.lock の Hub が生きているかは、pid が生きていて、かつ lock の URL が HTTP で応答する（`/manifest.webmanifest` が 200）ことで判定する。pid だけでは、異常終了で残った lock の pid が別のプロセスに再利用されたときに誤る
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
  - **ターン**: Agent の色の縦線でまとめ、見出し（Agent・状態・経過時間）、先頭に `▸ 作業 N 件`（枠の tool すべて。開いているときは一覧）、その後に発言を起きた順に（Web UI と同じ並び）
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
  - 取得は Clodex の起動時（project を開いたとき）に、Agent の Lazy Start を待たずにバックグラウンドで行う（ターンを送らないので利用枠を消費しない）。CLI の更新などで一覧が変わる（docs/spikes/model-list.md の追記）ので、Agent のプロセスを起動するたびに取り直す。ただし前の取得から 10 分以内なら取り直さない。取り直した一覧は state に反映し、取得に失敗したら前の一覧を残す。同じプロセスで利用状況も取得する（§利用枠の可視化と通知）。取得できるまで・失敗したときは空の一覧（「その他（入力）」だけ）。一覧は project によらないので Hub で共有する
  - リストは表示名を出し、選ぶと値を `/model <agent> <value>` で送る。リストの最後に「その他（入力）」を置き、自由に入力もできる
- 一覧は state に Agent ごとに `{ value, label }[]` で入れる。Claude は `resolvedModel` も持ち、今の model の表示（チップ・状態の行・`/status`）は値か `resolvedModel` が一致する項目の表示名にする（例: `claude-opus-5-5` → `Opus 5.5`）。一致しなければ値のまま
- スラッシュコマンドの `/model` の引数の候補は値を出し、表示名を説明として添える

入力:

- 入力欄の書きかけ（下書き）は会話ごとに持つ。会話やプロジェクトを切り替えたら、前の会話の下書きを取っておき、切り替え先の会話の下書きを入力欄に戻す（無ければ空）。プロジェクト（project root）と会話の ID の組で分ける
  - 端末の localStorage に会話ごとに保存する（画面を読み込み直しても残る）。空になったら消す。送信して入力欄が空になったら、その会話の下書きも消す
  - 送信待ちの「編集」で入力欄に戻した本文も、その会話の下書きとして扱う
  - 削除した会話の下書きは、次に会話の一覧を受け取ったときに消す（今のプロジェクトの下書きのうち、一覧に無い会話のもの。ほかのプロジェクトの下書きは触らない）
- スラッシュコマンドは引数まで候補を出す。コマンドごとに引数の候補を定義する（Agent 名、権限、effort の値、model の一覧、`/resume`・`/delete`・`/pin` の会話の番号と名前、`/project` の project、`/new` の `worktree` と Agent 名、`/cancel` の送信待ちの ID）。候補の元は state
- 候補はクリックでもタップでも選べる。選んでも入力欄のフォーカスは外さない（スマホではタップの click より先に入力欄の blur で一覧が閉じるので、指を離した時点で選ぶ。一覧をスクロールした指では選ばない）
- 入力欄が大きくなるとき: ログの一番下にいたら、入力欄が広がってもログの最後が見えるようにスクロールを合わせる。読み返している最中なら動かさない
- 入力欄の強調表示の層は textarea と同じ大きさに固定する（textarea の外まで広がって、入力欄の中に余白が増えないように）
- 先頭が `!` の入力（`!command`）は、Agent へのメッセージではないと分かる「コマンド入力」の見た目にする。先頭の `!` を消すと元に戻る。判定は 1 つの純関数（先頭が `!` か）にして Web UI と TUI で共有する
  - Web UI: 入力欄の枠と左端の印をコードの緑（インラインコードと同じ色）にし、本文を等幅フォントにする。入力欄の上に小さなラベル「コマンド」を出す。送り先の切り替えは使わないので薄くして無効にする。送信ボタンの文言は「実行」
  - TUI: 入力欄の枠をコードの緑にし、枠の上辺に「コマンド」のラベルを出す


### F — ブレスト

開発の流れとは別に、全 Agent（Claude・Codex・Gemini）の違う見方でアイデアを出し合い、**議論して練る**。違う model が互いの案を批評し、指摘された側が反論・修正するやり取りを重ねると、1 つの Agent に聞くより案の幅と質が上がるため。

- `/brainstorm [周回数] [--join] <テーマ>` で、今の project にブレスト用の会話を作って今の会話にし、最後まで自動で進める（人は途中で止めない）。周回数は議論の周の上限（1 以上の整数。既定 3。上限値の制限は設けない）。合意すれば上限より早く終える。Web UI は会話の一覧の「新しい会話」の横の「ブレスト」から、テーマと周回数を入れて始める
- 参加者は常に全 Agent（`AGENT_IDS`）
- 進め方（Coordinator が順に送る。Agent 同士の `send_message` は使わない）
  1. **開幕**（同時）: 全員に同時にテーマを送り、互いの案を見ずに案を出させる（最初の発言者の案に引きずられないため）。案には Agent ごとの ID（`AGENT_META.ideaPrefix`。Claude は `C1`・`C2`…、Codex は `X1`…、Gemini は `G1`…。最後まで通し番号）を付けさせる
  2. **議論**（順番に発言）: 1 周で全員が 1 回ずつ、1 体ずつ順に発言する。発言者には、自分の前回の発言の後に出た他の全員の発言（開幕の案を含む）を渡す。指示は「名指しの質問と自分の案への批評に答える（反論・修正・取り下げ）、他の案を ID で批評する、組み合わせ・新しい案を出す、必要なら相手を名指しで質問する」。発言順は周ごとに先頭を 1 つずつずらす（同じ Agent が毎回先に話さないため）
     - **反論役**: 各周で 1 体が反論役になり、周ごとに交代する（周 n は `AGENT_IDS[(n - 1) % N]`）。反論役は、有望とされている案ほど強い反論・見落とし・失敗する条件を挙げる。役とは別に、本心の評価（下記の立場）も書く
     - **立場**: 発言の最後に、全ての案への今の立場を決まった形で書かせる（`stance` のコードブロック。1 行に `<案 ID>: support | conditional | oppose`、最後の行は `open: none` か続けたい論点 1 行）。Coordinator が各 Agent の最新の立場を集計する
  3. **合意の判定**: 周の終わりごとに判定する。全員の最新の立場がそろっていて、どの案にも `support` と `oppose` が混ざっておらず、全員が `open: none` なら合意として議論を終える。立場を読み取れない Agent がいれば合意にしない。周回数の上限に達したら合意しなくても終える
  4. **まとめる**: primary の Agent に、全発言と立場の集計を渡し、結論（合意した案）・案の一覧・議論の経緯（主な反論と応答、案の修正・取り下げ）・未解決の論点にまとめさせる。案の一覧は表で、列は ID・提案者・各 Agent の最終の立場・現状（採用 / 修正して採用 / 保留 / 却下）・根拠（実測・コード・議論）。合意せず上限で終えたときは、割れた案と双方の主張を明記させる
- 画面: 周の見出しに「周 n/上限 · 反論役 <Agent>」を、議論の終わりに終えた理由（合意 / 上限）を出す
- ブレスト用の会話
  - 会話の履歴に `mode: "brainstorm"` を記録する。会話の一覧・タブに「ブレスト」の印を出す
  - 全 Agent を `read-only` で起動する（コードや資料を読んで案の材料にしてよいが、編集しない）。役割（`roles`）は使わず、ブレスト用の定型文を渡す（他の Agent も議論に加わっていること、案は具体的に、批評は ID で指す、名指しの質問には次の発言で答える、立場のブロックを毎回書く、`send_message` と `ask_user` は使わない）。言語の指示は今どおり
  - `send_message` は拒否する（solo と同じ扱い）
  - まとめの発言は `~/.clodex/artifacts/<project>/brainstorm-<日時>.md` にも保存し、最終応答にその path を書いて「資料」に出す
  - 終わった後は普通の会話として続けられる（人の入力は primary へ。全 Agent とも read-only のまま）
- 進行中（まとめを送る前）に人が入力したら、宛先によらず配送せずに溜め、**次の発言者**（まとめの番ならまとめ）への指示の先頭に「人が足したこと」として渡す。以降の発言者には議論の流れとして見える。ログの発言には「次の周へ」の印を付ける。割り込み（`@agent!`）とコマンドは今どおり。まとめを送った後の入力は通常の配送
- `/interrupt` はブレストを止める（残りの発言とまとめを送らない）。Hub が途中で止まったら、再起動後は中断として扱う（今どおり）
- 利用枠: 開幕 N + 周 × N + まとめ 1 ターン（N = Agent 数）。3 体・上限 3 周なら最大 13 ターン、1 周目で合意すれば 7 ターン
- 通知: ブレストの途中のターン（開幕・議論の発言）は、正常に終わったら通知しない（ターンの終わりの event に途中のターンの印を付ける。§28 通知の `handoff` と同じ扱い）。通知するのは、まとめのターンの終わり（ブレストの完了）と、問題があったとき（ターンの失敗・中断、Agent のエラー、利用枠の上限で停止）だけ。下の「人も参加するモード」で人の番が来たときは、人への質問と同じく通知する（本文「あなたの番です。」/ "Your turn."）
- **人も参加するモード**（任意）: 開始時に選ぶと、人も議論の発言者の 1 人になる。`/brainstorm [周回数] --join <テーマ>`、Web UI はブレストのフォームの「参加」のトグル。会話の履歴の `brainstorm` に `join: true` を記録する
  - 人の番は、開幕の後と、議論の各周の最後（全 Agent が発言した後）。人の番が来たら進行を止めて待つ（時間切れは無い）
  - 人の番の操作: 普通に入力して送ると、それが人の発言になる（宛先によらず配送しない）。`/pass` で発言せずに進める。`/conclude` で議論を終えてまとめへ進む（上限・合意を待たない）。Web UI は人の番の間、入力欄の上に「あなたの番」と、パス・まとめへ のボタンを出す
  - 人の発言は、以降の発言者に「Human」の発言として渡す（Agent の発言と同じ扱い）。人が案を出したら、最初にそれを取り上げた Agent が `H1`・`H2`…の ID を付ける（定型文で指示する）。人は `stance` ブロックを書かなくてよい
  - 合意の判定: Agent の立場だけで判定する。ただしその周に人が発言したら、その周では合意にしない（人の発言に Agent が応える周を必ず 1 回挟む）。上限の周で人が発言したときも、Agent が応える周を 1 回だけ足してからまとめへ進む
  - 人の番以外の入力は、今どおり溜めて次の発言者に渡す
  - 利用枠: 人の番はターンを使わない。上限の後に足す周の分（最大 N ターン）だけ増えうる

#### 開発への引き継ぎ

ブレストで決まった内容を、そのまま開発の会話に渡す。ブレストの会話は read-only で役割も無いので、開発は普通の会話で始め直す。

- `/develop [指示]`: まとめを終えたブレストの会話で使う。今の project に**普通の会話**（`mode` なし。役割・権限は通常どおり）を作って今の会話にし、primary の Agent に最初の入力として引き継ぎの指示を送る
  - 引き継ぎの指示（英語の定型文 + 人の指示）: まとめの資料の path（`brainstorm-<日時>.md`）、ブレストのテーマ、「資料を読み、採用・修正して採用になった案を開発に移す。自分の役割の手順（設計書・委譲など）で進める」。人の `[指示]` があれば「人の指示」として続ける（どの案を進めるか、範囲など）。資料の本文は貼らずに path で渡す（§3.5）
  - 新しい会話の履歴に元のブレストの会話 ID を記録する（`from: { brainstorm: <会話 ID> }`）。会話の一覧・タブに引き継ぎ元が分かる印を出し、押すと元のブレストに移れる
  - まとめを終えていない（進行中・中断・まとめ失敗）ブレスト、ブレストでない会話では拒否する（「まとめの後に使える」）
- Web UI: まとめを終えたブレストの会話の、まとめの見出しに「開発へ」のボタンを出す。押すと任意の指示を入れる欄（空でもよい）を出し、`/develop [指示]` を送る

### G — Gemini（Antigravity CLI）と N 体の Agent

Google AI プランの購読で使える Antigravity CLI（`agy`）を 3 体目の Agent `gemini` として足す（API キーは使わない。認証は agy 自身の Google OAuth ログイン）。agy の headless は stdin/stdout の stream-json（`--input-format stream-json --output-format stream-json`。1 プロセスで複数ターン、`init` / `step_update` / `result` の NDJSON）を持ち、`--conversation <id>` で再開できる。実装の前に `spikes/` で実測する（イベントの実際の形・中断・permission・`agy models`・利用枠・MCP の設定）。

段階:

- **G1 — N 体対応の一般化**（agy 不要）: 「相手は 1 体」の前提と `{ claude, codex }` の手書きリテラルをなくし、`AGENT_IDS` と Agent ごとのメタデータ（registry）駆動にする。`AGENT_IDS` は 2 体のまま変えない
- **G2 — UI の N 体対応**: 送り先・カードの列・色・`@` の解析を registry 駆動にする
- **G3 — agy の spike**: 人が agy を導入・ログインした後に実測し、`docs/spikes/antigravity.md` に記録する
- **G4 — AntigravityAdapter**: Adapter・permission の対応・model / effort・利用枠・sandbox・`AGENT_IDS` への `gemini` 追加
- **G5 — 仕上げ**: 役割プリセットの 3 者化、ブレストの確認、Budget の既定値の見直し、受入 E2E

G4（AntigravityAdapter）の設計（docs/spikes/antigravity.md の実測が根拠）:

- `AGENT_IDS` に `gemini` を足す。registry は name `Gemini`・mark / 案 ID `G`・effort は持たない（model の slug が effort 込み。§9 Model / Effort）・message の `effort` は受けない・usage は累積
- Adapter: `agy --input-format stream-json --output-format stream-json` の常駐プロセス（`AgentProcess` / `BaseAgentAdapter` の形）。実行ファイルは PATH に無ければ `%LOCALAPPDATA%agyinagy.exe`
  - session = `init` の `conversation_id`。再開・プロセスの入れ替えは `--conversation <id>`
  - event の対応: `step_update` の `agent_response`（`text_delta` を連結し、step の DONE で `text`）、`tool`（`tool_info.name` と parameters。`run_command` は検証の証跡の `command` に、ファイル系の tool は `files` に写す）、ターンごとの `result` で `turn`（本文は `response`）。`denied_actions` が付いたら warn の notice を出す
  - 中断: stdin に control は送れないので、プロセスを kill して `--conversation` で入れ替える（kill してもサーバー側でターンが完走することがある）
  - model / effort / permission は起動引数。変更はプロセスの入れ替えで反映する
- MCP（`send_message` などの経路）: グローバル `~/.gemini/config/mcp_config.json` に stdio の中継（Clodex が同梱する proxy script）を `clodex` の名前で登録し、会話ごとの URL は agy の起動 env（`CLODEX_MCP_URL`）で渡す（agy は自分の env を MCP の子プロセスへ引き継ぐ。実測済み）。`~/.gemini/antigravity-cli/settings.json` の `permissions.allow` に `mcp(clodex/*)` が無ければ足す（他のキーは保つ）。どちらも gemini の起動時に確かめて書く
- 組み込みの tool に `send_message` が別にあるので、定型文・envelope では「the send_message tool of the \"clodex\" MCP server」の形を保つ（既にそうなっている）
- model の一覧は `agy models`（ターンを送らない）。利用枠の percent と reset は headless から取れないので、gemini の利用枠ゲージは出さない（token の累積だけ）
- sandbox は当面 gemini 非対応: sandbox が有効な project では gemini を起動できない（分かる文言のエラー）。対応は将来
- 設定: 起動オプション `--gemini-model`。roles・rules などの Agent キーは G1 で一覧駆動になっているので、`gemini` を書けば効く

N 体の設計の決まり（G1〜G2 の仕様）:

- 「相手」は集合にする: `peersOf(id)` = 自分以外の全 Agent。人の発言の共有（queueHumanContext）・利用枠の上限の通知・相手が編集したファイルの記録は、宛先（本人）以外の全員に対して行う
- Agent ごとの違い（表示名・mark・色・既定の色変数・effort の段階・message の `effort` を受けるか・usage hint・inputTotal の数え方・ブレストの案 ID の接頭辞）は、1 つの registry にまとめる。`=== "claude" ? A : B` の二択で gemini が暗黙に codex 扱いになる形を残さない
- 設定（`roles`・`rules`・`usageHints`・`threadTokenWarn`）と保存形式（sessions・settings・recovery）の Agent 名のキーは、`AGENT_IDS` からスキーマを組み立てる。すべて省略可にし、recovery の `queue` は無い Agent を空で補う（古いファイルを読めなくしない）
- solo は今のまま「1 体だけ」（`"free" | AgentId`）。部分集合のモードは作らない
- ブレストは議論の発言ごとに「自分の前回の発言の後に出た他の全員の発言」を渡す（§28 F）
- 定型文は「peer は 1 人」の文面をやめ、自分以外の全員の役割を並べる。`@all` の文言も「全員」にする
- message の `effort` は「宛先が codex か」ではなく registry の能力で判定する
