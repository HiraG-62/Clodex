# Clodex で開発するプロジェクトのためのガイド

Clodex を使って既存のプロジェクトを開発するときに、知っておくことと、プロジェクト側で用意するもの（CLAUDE.md・`.clodex.json` など）をまとめる。このファイルを AI に読ませて、プロジェクトの CLAUDE.md を整えるときの材料にしてよい。

Clodex 自体の設計は [DESIGN.md](DESIGN.md)、インストールと操作は [README.md](../README.md)。

## 1. Clodex とは

Claude Code と Codex CLI を、Windows ネイティブ環境で 1 つのプロジェクトに対して同時に動かし、協調させる薄い Development Shell。

- 2 つの Agent（`claude` と `codex`）が同じリポジトリで作業する。どちらも各 CLI のサブスクリプションで動き、API キーの従量課金は使わない
- 人は TUI（`clodex`）・Web UI・GUI のどれかから指示を送る。通常の入力は primary Agent（既定は `claude`）に届き、`@codex ...` のように宛先を指定もできる
- Agent 同士は、Clodex が提供する MCP tool `send_message` で依頼・質問・結果を送り合う。Agent の画面出力をそのまま相手に流すことはしない
- 各 Agent は本物の Claude Code / Codex CLI として動く。CLAUDE.md・AGENTS.md・skill・hook・MCP など、各 CLI のふだんの設定はそのまま効く

Clodex がやらないこと:

- Agent の作業内容を AI で計画・分配すること（分担は人が役割で決める）
- 自動マージ・自動の worktree 運用・コンフリクト解決
- Agent の出力の自動翻訳

## 2. 仕組み

```text
人 ── TUI / Web UI / GUI
        │
       Hub（常駐。project と会話を管理）
        │
       会話 ── Coordinator ──┬── claude（Claude Code）
                 │           └── codex（Codex CLI）
                 └── MCP server（send_message / ask_user）
```

- **project**: Agent が作業するディレクトリ。`clodex` を実行した場所の git のルート（`--project` や `/project` で変えられる）
- **会話**: project の中の 1 つの作業の流れ。`/new` で新しく始め、`/resume` で戻れる。`/new worktree` は会話用の git worktree（`<project の隣>/<project 名>-<短い ID>`、ブランチ `clodex/<短い ID>`）を作り、そこで作業する
- **Lazy Start**: Agent は必要になるまで起動しない。依頼が届いた時点で起動し、以前の session があれば続きから再開する
- **mailbox**: 各 Agent への入力（人の入力と相手からの message）は順番に 1 つずつ届く。作業中のターンには割り込まない（割り込みは明示したときだけ）

## 3. Agent 同士のやり取り

### message の種類

| type | 用途 |
|---|---|
| `DELEGATE` | 実装・調査の委譲 |
| `REVIEW_REQUEST` | レビュー依頼 |
| `QUESTION` | 相手への質問 |
| `RESULT` | 依頼への結果（`status`: `approved` / `changes_requested` / `done` / `failed`、`issues` で指摘を返せる） |
| `ISSUE` | 問題の報告 |

- 依頼の詳細は body（最大 4,000 文字の要約）ではなく、**設計書**（既定 `docs/specs/<taskId>.md`）に書いて `spec` で渡す。設計書の作成・コミットは依頼する側が行う
- 受け取った側には、依頼に加えて、リポジトリのパス・commit・ファイル・設計書のパスだけが渡る。会話の履歴は渡らないので、必要な情報はリポジトリから読む
- 人に判断を求めるときは MCP tool `ask_user` を使う（選択肢つきの質問として画面に出る）

### 上限

Agent 同士の無限のやり取りを防ぐため、人の 1 回の入力から始まる一連のやり取りに上限がある（既定: message 8 件、レビュー 3 回、委譲と質問の合計 4 回、依頼の入れ子の深さ 2）。上限に達すると Agent は人に報告して止まる。変えるには `/limits` か `.clodex.json` の `limits` を使う。

### solo

`/solo` で Agent 同士のやり取りを止め、片方だけで作業させられる。

## 4. Agent に自動で渡されるもの

Clodex は Agent の起動時に、次の内容を system prompt に追加する。プロジェクトの CLAUDE.md に同じことを書く必要はない。

- 相手の Agent がいること。自分と相手の役割（`.clodex.json` の `roles`）
- 相手の役割の作業は `send_message` で依頼し、自分ではやらないこと
- 依頼は設計書を書いて `spec` で渡すこと（既定の置き場所 `docs/specs/<taskId>.md`）
- `send_message` の body は「1 行の要約 → 箇条書き」で書くこと
- 人への質問は `ask_user` を使うこと
- 依頼を受けたら、作業の前に何をするかを 1〜2 文で書くこと
- 権限が拒否されたら、人に `/permission` を案内すること
- 人が読む文章の言語（`language` の設定、無ければ OS のロケール）

また、Agent のプロセスには環境変数 `CLODEX_AGENT=claude|codex` が付く。hook や skill で「Clodex の配下で動いているか」を判定できる（例: 単体で使うときの委譲用 plugin を Clodex の配下では無効にする）。

## 5. プロジェクト側で用意するもの

### CLAUDE.md（両 Agent 共通のルール）

- Claude は `CLAUDE.md` を読む。Codex は `AGENTS.md` を読むが、`AGENTS.md` が無いプロジェクトでは Clodex が Codex にも `CLAUDE.md` を読ませる
- **両 Agent に同じルールを守らせたいなら、`CLAUDE.md` だけを置き、`AGENTS.md` は置かない**のがよい。`AGENTS.md` を置くと、Codex は `CLAUDE.md` を読まなくなる
- **Clodex で管理できることは CLAUDE.md / AGENTS.md に書かない**。役割の分担（誰が設計・実装・レビュー・コミットするか）、Agent 同士の依頼の仕方、設計書の置き場所、言語、権限は、Clodex の設定（`.clodex.json`）と Clodex が自動で渡す指示（4）で決まる。CLAUDE.md にはプロジェクトそのもののルールだけを書く

CLAUDE.md に書くとよいこと:

| 項目 | 理由 |
|---|---|
| プロジェクトの概要と主要なディレクトリ | 依頼に会話の履歴が付かないため、受け取った側はリポジトリから文脈をつかむ |
| テスト・型チェック・lint・ビルドのコマンド | 役割の「テストを通してから報告する」を、Agent が正しいコマンドで実行できるようにする |
| 機能追加の進め方（資料 → テスト → 実装 など） | 両 Agent の進め方をそろえる |
| 設計資料・仕様書の場所 | 設計書（spec）から参照させる |
| コーディング規約・命名・禁止事項 | 実装する側とレビューする側で基準をそろえる |
| コミットメッセージの形式 | どちらの Agent がコミットしても形式をそろえる |
| 実行に人の了承が要るコマンド（課金される E2E、デプロイなど） | Agent が勝手に実行しないようにする |

書かないこと: 4 の内容と、`.clodex.json` で決めること（役割の分担・コミットの担当・設計書の置き場所・言語・権限）。

### `.clodex.json`（プロジェクトの Clodex の設定）

プロジェクトのルートに置く。`~/.clodex/config.json`（全プロジェクトの既定）を、トップレベルのキー単位で上書きする。

```json
{
  "primary": "claude",
  "permission": "edit",
  "roles": {
    "claude": "設計とレビュー、コミットを担当する。設計書を書いて、実装は codex に DELEGATE する。codex の実装結果は差分を確認し、テストと型チェックを通してからコミットする。数行で済む修正は自分で行ってよい。",
    "codex": "実装を担当する。claude の DELEGATE に従ってテストとコードを書き、テストと型チェックを通してから RESULT で報告する。設計に迷ったら claude に QUESTION する。コミットはしない。"
  },
  "worktree": { "setup": "pnpm install" }
}
```

| キー | 内容 |
|---|---|
| `roles` | 各 Agent の役割。自由な文章。分担・コミットの担当・設計書の置き場所など、Agent ごとの振る舞いはここに書く。空なら役割なし（相手がいることだけを伝える） |
| `primary` | 通常の入力の送り先 |
| `permission` | 起動時の権限（`read-only` / `edit` / `full`）。既定は `edit` |
| `worktree.setup` | `/new worktree` で作った worktree で最初に実行するコマンド。git が持たない依存関係（`node_modules` など）を入れる |
| `limits` | 3 の上限 |
| `language` | 人が読む文章の言語（`ja` / `en`） |

`/role` で役割を変えると `.clodex.json` に保存される。

### 設計書の置き場所

既定は `docs/specs/<taskId>.md`。別の場所にしたいときは `roles` に書く。設計書はコミットして履歴に残す前提。

## 6. 権限と制約

| 権限 | Claude | Codex |
|---|---|---|
| `read-only` | 読み取りと計画だけ | 読み取りだけ |
| `edit`（既定） | ファイル編集を自動で許可。それ以外のコマンドはユーザー設定の許可に従う | プロジェクト内の書き込みとネットワークを許可 |
| `full` | すべて許可 | すべて許可 |

- Agent はその場で人に権限の確認を求められない。拒否されたら、人が `/permission` で変える
- **Codex は `edit` では git のコミットができない**（Codex の sandbox が `.git` への書き込みを許さないため）。`roles` でコミットを Claude か人の担当にするか、Codex を `full` にする
- Codex の `edit` では、Schannel を使う HTTPS（`curl.exe`、Windows PowerShell 5.1 の `Invoke-WebRequest`）が失敗する。Node・pnpm・git の通信は通る
- `/sandbox on` にすると、Agent を専用のローカルユーザーで動かし、プロジェクトの外への書き込みを OS で止める（[DESIGN.md §9 Sandbox](DESIGN.md#sandbox)）。この間、人の `~/.claude`・`~/.codex` の設定は Agent から見えない
- push は人が行う前提（Agent に git の資格情報を渡す仕組みはない）

## 7. 導入の手順

1. Claude Code CLI と Codex CLI にサブスクリプションでログインしておく（`claude auth status` / `codex login status`）
2. プロジェクトの `CLAUDE.md` を 5 の表に沿って整える。役割の分担など Clodex で管理することが書かれていれば `roles` に移す。`AGENTS.md` があれば、内容を `CLAUDE.md` に統合して消すか、Codex 固有の差分だけにする
3. `.clodex.json` に `roles` を書く（全プロジェクト共通でよければ `~/.clodex/config.json` に書く）。worktree を使うなら `worktree.setup` も書く
4. プロジェクトのディレクトリで `clodex` を実行する（GUI ならフォルダを選ぶ）
5. 最初は小さな依頼で、分担・テストの実行・コミットの流れが役割どおりに動くかを確かめる

## 8. CLAUDE.md の雛形

````markdown
# <プロジェクト名>

<何をするプロジェクトか 1〜2 文>。設計は `docs/...`。

## ルール

- 応答・コメント・コミットメッセージは日本語
- 機能追加の順序: 資料を更新 → テストを書く → 最小実装 → 資料との矛盾を確認
- <コーディング規約・禁止事項>
- コミットメッセージは `<type>: <概要>`
- <人の了承が要るコマンド>

## コマンド

```powershell
pnpm test
pnpm typecheck
pnpm lint
```

## 構成

- `src/...`: <役割>
````
