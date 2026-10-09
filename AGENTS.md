# Clodex

Claude Code と Codex CLI を Windows ネイティブ環境で協調させる薄い Development Shell。設計は `docs/DESIGN.md`、CLI の実測結果は `docs/spikes/`。

## ルール

- 応答・コードコメント・コミットメッセージは日本語。技術用語は英語のままでよい
- パッケージマネージャは pnpm（npm / yarn は使わない）
- 機能追加・仕様変更の順序: `docs/DESIGN.md` を更新 → テストを書く → 最小実装 → 資料との矛盾を確認
- CLI の挙動に依存する変更は、推測で実装せず `spikes/` で実測し、結果を `docs/spikes/` に記録する
- `any` は使わない。マジックナンバー・文字列は定数にする。早期リターンでネストを浅く保つ
- コミットメッセージは `<type>: <概要>`（type: feat, fix, refactor, docs, style, test, chore）。1 コミット = 1 つの論理的変更
- GUI のリリース（DESIGN.md §28 GUI の自動更新）: dev 版は master への push で CI が自動で公開する。版の変更と tag の作成はしない
- 本番リリースは人が指示したときだけ行う。`package.json` の `version` を上げてコミットし、`v<version>` の tag を作る（push は人が行う）
- 公開済みの tag は付け直さない・消さない。CI が失敗したら版を上げて出し直す

## コマンド

```powershell
pnpm test        # ユニットテスト
pnpm test:spikes # spikes/ の実測のテスト（spike を直したときだけ）
pnpm typecheck
pnpm lint        # biome の lint と format の確認（pnpm format で直す）
pnpm build       # clodex コマンドに反映する
```

- 実 CLI を使う E2E（`*.e2e.test.ts`）はサブスクリプションの利用枠を消費する。`CLODEX_E2E=1` を付けたときだけ実行され、実行前に人の了承を取る
- `src/acceptance.e2e.test.ts` は v0.1 の受入シナリオ。起動処理や表示を変えたら実行する

## 画面の確認（Web UI）

本物の Hub・設定・会話に触れないよう、一時の Hub で確かめる。

- `CLODEX_HOME` に空の一時フォルダを指定し、その `.clodex/config.json` に別のポート（例: `{"web":{"port":47999}}`）を書いて `pnpm dev serve` で起動する。一時フォルダはリポジトリの外（`%TEMP%` の下など）に置く（`rm` は使えないので、リポジトリの中に残さない）
  - 実データ（`~/.clodex/state`）を写すときは、`*.recovery.json` を写さない。写すと作業中だった Agent を本物のセッションで動かしてしまう
  - PowerShell では `$HOME`（予約済みの変数で本物のホームを指す）を一時フォルダの変数名に使わない。本物の `~/.clodex/config.json` を上書きしてしまう
- 終わったら一時の Hub を止める（`<一時ホーム>\.clodex\hub.lock` の `pid` を `taskkill /PID <pid> /T /F`）
- スクリーンショットは `C:\Users\Horry\.clodex\artifacts\<project>\` に保存する

## 構成

- `src/agents/`: Claude / Codex の Adapter（stdio プロトコル。DESIGN.md §9・§10）
- `src/coordinator/`: Coordinator・mailbox・Budget・利用枠・Event Bus
- `src/mcp/`: Agent → Coordinator の formal message（`send_message`）
- `src/cli/`、`src/index.ts`: 入力の解釈と terminal I/O
- `src/hub/`: Hub・ProjectContext・Workspace（会話ごとの runtime）・復旧
- `src/web/`（`client/` はブラウザ側）、`src/tui/`、`gui/`（Tauri）: 画面
- `src/project/`: 会話の履歴・設定などの保存、`src/sandbox/`: Windows の sandbox
- 依存の向き: Coordinator → AgentAdapter interface ← 各 Adapter
