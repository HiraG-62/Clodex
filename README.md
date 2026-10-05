# Clodex

Windows ネイティブ環境で Claude Code と Codex CLI を対等な開発エージェントとして協調させる、薄い Development Shell。

設計: [docs/DESIGN.md](docs/DESIGN.md) / Phase 0 の検証結果: [docs/spikes/](docs/spikes/README.md)

## 前提

- Windows 11 / Node.js 22 以上 / pnpm
- Claude Code CLI と Codex CLI がインストール済みで、それぞれサブスクリプションでログイン済み（`claude auth status` / `codex login status`）
- API key の環境変数（`ANTHROPIC_API_KEY` 等）は Agent に渡さない。サブスクリプション認証でなければ Agent は起動しない

## セットアップ

```powershell
pnpm install
pnpm build
```

`clodex` コマンドは、PATH 上（例: `pnpm setup` で作られる `%PNPM_HOME%`）に shim を置いて使う。pnpm 10 の `pnpm link --global` はローカルディレクトリの bin を作らないため。

```bat
:: %PNPM_HOME%\clodex.cmd
@ECHO off
node "E:\dev\Clodex\dist\index.js" %*
```

ソースを変更したら `pnpm build` で反映される。

## 使い方

```powershell
PS C:\dev\my-project> clodex
```

| 入力 | 動作 |
|---|---|
| テキスト | primary Agent（既定 Claude）へ送信 |
| `@claude ...` / `@codex ...` | 指定 Agent へ送信 |
| `/interrupt [claude\|codex]` / Ctrl+C | 実行中のターンを interrupt |
| `/status` / `/help` / `/exit` | 状態表示 / ヘルプ / 終了 |

Agent 同士は MCP tool `send_message` で formal message をやり取りする。Agent は必要になるまで起動しない。

起動オプション: `--project <path>` / `--primary <claude|codex>` / `--claude-model <model>` / `--codex-model <model>`

ログ: `~/.clodex/logs/<project 名>-<起動時刻>.jsonl`

## 開発

```powershell
pnpm test        # ユニットテスト
pnpm typecheck
pnpm dev         # ビルドせずに起動
```

実 CLI を使う E2E はサブスクリプションの利用枠を消費するため、明示したときだけ実行する。

```powershell
$env:CLODEX_E2E = "1"; pnpm test; Remove-Item Env:CLODEX_E2E
```
