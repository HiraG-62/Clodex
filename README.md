# Clodex

Windows ネイティブ環境で Claude Code と Codex CLI を対等な開発エージェントとして協調させる、薄い Development Shell。

設計: [docs/DESIGN.md](docs/DESIGN.md) / CLI の検証結果: [docs/spikes/](docs/spikes/README.md)

## 前提

- Windows 11
- Claude Code CLI と Codex CLI がインストール済みで、それぞれサブスクリプションでログイン済み（`claude auth status` / `codex login status`）
- API key の環境変数（`ANTHROPIC_API_KEY` など）は Agent に渡さない。Agent はサブスクリプション認証で動かす
- ソースからビルドする場合は Node.js 22 以上と pnpm

## インストール

### GUI（推奨）

[GitHub Releases](https://github.com/HiraG-62/Clodex/releases/latest) の `Clodex_<version>_x64-setup.exe` を使う。ソースから作るときは、リポジトリで `pnpm install`、`pnpm gui:build` を実行し、`gui/src-tauri/target/release/bundle/nsis/` のインストーラーを使う。GUI には Node と Clodex 本体が同梱されるため、インストール先の PC で Node や `clodex` を PATH に入れる必要はない。Claude Code CLI と Codex CLI は必要。

GUI は起動時に新しい版を確認し、あれば更新するか聞く。トレイの「更新を確認」でも確認できる。

ウィンドウを閉じるとトレイに残り、終了はトレイのメニューから行う。ウィンドウが非表示かフォーカスがないときは作業終了・通知・エラーを Windows の通知で知らせる。ビルドと起動の詳細は [gui/README.md](gui/README.md)、GUI の設計は [DESIGN.md §28](docs/DESIGN.md#28-future-roadmap)。

### CLI

```powershell
pnpm install
pnpm build
```

`clodex` コマンドは、PATH 上（例: `pnpm setup` で作られる `%PNPM_HOME%`）に shim を置いて使う。pnpm 10 の `pnpm link --global` はローカルディレクトリの bin を作らないため。

```bat
:: %PNPM_HOME%\clodex.cmd
@ECHO off
node "C:\path\to\Clodex\dist\index.js" %*
```

shim のパスは実際のリポジトリの場所に置き換える。ソースを変更したら `pnpm build` で反映する。

## 起動と会話

GUI を起動するか、project のディレクトリで `clodex` を実行する。`clodex` は TUI を開き、Hub が動いていれば接続する。`clodex serve` は画面なしで Hub と Web UI を起動し、`clodex --web` は TUI と Web UI を起動する。

`/project [path]` で project を切り替える。GUI ではフォルダを選べる。`/new` は新しい会話、`/new worktree` は worktree の会話を作る。`/resume [番号]` で会話の一覧表示・切り替えができる。詳しくは [DESIGN.md §6](docs/DESIGN.md#6-project-と-workspace)・[§18](docs/DESIGN.md#18-persistence)。

## 入力

| 入力 | 動作 |
|---|---|
| テキスト | primary Agent に送信 |
| `@claude ...` / `@codex ...` | 指定 Agent に送信 |
| `@all ...` / `@all! ...` | 両 Agent に送信。`!` は実行中のターンに指示を足す |
| `@claude! ...` / `@codex! ...` | 実行中のターンに指示を足す。実行中でなければ通常送信 |
| `@<path>` | project 内のファイルを参照として添える |
| `!command` | project root で shell command を実行し、出力を表示 |
| `!& command` | background process を起動。Ctrl+C や `/interrupt` では止まらない |
| `/processes [番号]` / `/kill <番号>` | background process の一覧・出力表示 / 停止 |
| `/interrupt [agent]` / Ctrl+C | 実行中のターンや `!command` を中断 |
| `/cancel [id]` | 未配送の人間の入力を取り消す |
| `/project [path]` / `/primary <agent>` / `/role [agent] [text]` | project・通常入力の送り先・役割を変更 |
| `/new [worktree\|agent]` / `/resume [番号]` | 会話の作成・切り替え |
| `/rename <title>` / `/delete <番号>` / `/pin <番号>` | 会話の名前・削除・ピン止め |
| `/permission [agent] <level>` / `/model <agent> <model>` / `/effort [agent] <level>` | Agent の権限・model・reasoning effort を変更 |
| `/compact [agent]` / `/status` / `/verbose` | コンテキストの圧縮・状態の表示・詳細表示の切り替え |
| `/help` / `/exit` | 入力方法の表示 / 終了 |

入力の詳細は [DESIGN.md §8](docs/DESIGN.md#8-input-ux)、background process は [§15](docs/DESIGN.md#15-process-manager)。

## 設定ファイル

`~/.clodex/config.json` は全 project の既定値、project root の `.clodex.json` はその project の設定。project 側の値がトップレベルのキー単位で上書きする。設定できるキーは `roles`、`primary`、`permission`、`language`、`limits`、`web`、`usageAlert`。

```json
{
  "roles": {
    "claude": "設計とレビューを担当する。",
    "codex": "実装を担当する。"
  }
}
```

`/role` で project の役割を書き換えられる。役割の詳細は [DESIGN.md §13 Roles](docs/DESIGN.md#rolesv02)、権限は [§9 Permission](docs/DESIGN.md#permission)、利用枠の通知は [§14](docs/DESIGN.md#14-budget-manager)。

## スマホから使う

Hub の Web UI は PC の `127.0.0.1` だけで待ち受ける。PC とスマホに Tailscale を入れ、tailnet で Serve と HTTPS を有効にして、PC で次を実行する。

```powershell
tailscale serve --bg 4319
```

スマホでは初回に `https://<PC名>.<tailnet>.ts.net/?token=<token>` を開く。`<token>` には PC の `~/.clodex/web-token` に保存された値を入れる。以後は cookie で接続できる。Hub が動いている間だけつながるため、GUI から使う場合はトレイに残す。接続の詳細は [DESIGN.md §17 Web UI](docs/DESIGN.md#web-uiv02)。

## 保存されるもの

`~/.clodex/` に会話の state、logs、artifacts、uploads、`hub.json`、`web-token` を保存する。Hub の再起動時は配送待ちの入力と作業中だった Agent のターンを戻す。詳細は [DESIGN.md §18 Persistence](docs/DESIGN.md#18-persistence)。

## 開発

```powershell
pnpm test
pnpm typecheck
pnpm build
```

実 CLI を使う E2E はサブスクリプションの利用枠を消費し、`CLODEX_E2E=1` を設定したときだけ実行する。テスト方針は [DESIGN.md §20](docs/DESIGN.md#20-v01-acceptance-criteria)。
