# Clodex

Claude Code と Codex CLI を Windows ネイティブ環境で協調させる薄い Development Shell。設計は `docs/DESIGN.md`、CLI の実測結果は `docs/spikes/`。

## ルール

- 応答・コードコメント・コミットメッセージは日本語。技術用語は英語のままでよい
- パッケージマネージャは pnpm（npm / yarn は使わない）
- 機能追加・仕様変更の順序: `docs/DESIGN.md` を更新 → テストを書く → 最小実装 → 資料との矛盾を確認
- CLI の挙動に依存する変更は、推測で実装せず `spikes/` で実測し、結果を `docs/spikes/` に記録する
- `any` は使わない。マジックナンバー・文字列は定数にする。早期リターンでネストを浅く保つ
- コミットメッセージは `<type>: <概要>`（type: feat, fix, refactor, docs, style, test, chore）。1 コミット = 1 つの論理的変更

## コマンド

```powershell
pnpm test        # ユニットテスト
pnpm typecheck
pnpm build       # clodex コマンドに反映する
```

- 実 CLI を使う E2E（`*.e2e.test.ts`）はサブスクリプションの利用枠を消費する。`CLODEX_E2E=1` を付けたときだけ実行され、実行前に人の了承を取る
- `src/acceptance.e2e.test.ts` は v0.1 の受入シナリオ。起動処理や表示を変えたら実行する

## 構成

- `src/agents/`: Claude / Codex の Adapter（stdio プロトコル。DESIGN.md §9・§10）
- `src/coordinator/`: Coordinator・mailbox・Budget・利用枠・Event Bus
- `src/mcp/`: Agent → Coordinator の formal message（`send_message`）
- `src/cli/`、`src/index.ts`: 入力の解釈と terminal I/O
- 依存の向き: Coordinator → AgentAdapter interface ← 各 Adapter
