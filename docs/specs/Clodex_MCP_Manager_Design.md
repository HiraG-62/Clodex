# Clodex MCP Manager 設計

## 目的

Clodexに汎用MCPマネージャーを追加し、Claude Code・Codex CLI・Antigravity CLIで使用するMCPサーバーの設定を一元管理する。

Google Sheetsなど個別サービス向けのMCP機能はClodex自身に実装しない。

## 基本方針

- **設定同期型**を採用。MCPプロトコルによるツール実行・認証は原則各CLIに委任する。
- ClodexはMCPサーバーの登録・編集・削除・有効化・エージェント割り当てを管理する。
- `stdio` と HTTP系トランスポートに対応する（CLIごとの対応形式はアダプターで検証する）。
- グローバル／プロジェクト別スコープを区別する。
- 各CLIで既に設定されているMCPを読み込み、Clodex管理対象と外部管理対象を区別する。

## アーキテクチャ

```text
Clodex (Tauri)
  └─ MCP Manager (UI + 設定ストア)
       ├─ Claude Code Adapter → Claude Code MCP設定
       ├─ Codex Adapter       → Codex CLI MCP設定
       └─ Antigravity Adapter → Antigravity CLI MCP設定
                                      ↓
                          各CLIがMCPサーバーに接続
```

## 主な機能

1. **サーバー管理**：名前、起動コマンド・引数／URL、環境変数、トランスポート方式を登録・編集・削除。
2. **割り当て**：サーバーごとにClaude Code／Codex／Antigravityへの適用を切り替える。
3. **設定同期**：各CLIの設定を読み書きし、外部からの設定変更も検出する。
4. **状態確認**：設定済み・未設定・設定不正などを表示。接続状態を直接取得できない場合は「未確認」とする。
5. **適用前プレビュー**：変更差分を提示してから保存・同期する。

## 内部設定例

```json
{
  "servers": {
    "example-server": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "example-mcp-server"],
      "envRefs": {},
      "scope": "project",
      "agents": {
        "claude": true,
        "codex": true,
        "antigravity": false
      }
    }
  }
}
```

このJSONはClodex内部の抽象形式。各CLIの設定形式へアダプターで変換する。

## 実装上の注意

- 既存の設定を**全置換しない**。Clodex管理対象のみ差分更新し、非管理対象は維持する。
- 変更前に対象設定を再読み込みし、競合を検出する。失敗時に戻せるようバックアップと原子的な書き込みを行う。
- APIキー・OAuthトークンは平文の共通設定へ保存せず、OSの資格情報ストアまたは各CLIの認証機構を使用する。
- 環境変数と認証方式はCLIごとに差があるため、未対応項目は警告し、黙って省略しない。
- CLIの設定ファイルの位置・スキーマ・コマンドは更新され得るため、実装時に各CLIの公式仕様で確認する。
- MCPの有効化と実際の接続・認証成功は区別する。

## 実装順序

1. 設定モデルとCLIアダプターのインターフェースを定義。
2. Claude Code／Codexの既存設定読み込み・差分同期を実装。
3. MCP Manager UI（一覧・編集・エージェント割り当て・適用プレビュー）を実装。
4. Antigravityアダプターを追加。
5. 外部変更検出、エラー処理、設定のバックアップを整備。

## 対象外（初期版）

- Clodex自身によるMCPツールの実行・中継
- Google Sheetsなど特定サービス専用のUI・API実装
- ClodexがOAuth認証フローを一括代行する機能
- MCPサーバーのホスティング・プロキシ化
