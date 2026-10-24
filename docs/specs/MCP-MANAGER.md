# MCP-MANAGER: MCP マネージャ（設定同期型）

各 CLI（Claude Code / Codex CLI / Antigravity CLI）が使う MCP サーバーの設定を Clodex で一元管理する。仕様の正は `docs/DESIGN.md` §19（この実装で追加済み）。元の提案は `docs/specs/Clodex_MCP_Manager_Design.md`。

段階を踏んで実装する。段階 1 の実測が終わるまで段階 3 のアダプターの書き込みは実装しない。

1. **Spike（実測）**: 各 CLI の MCP 設定の場所・スキーマ・公式コマンドを実測し `docs/spikes/mcp-manager.md` に記録
2. **内部モデルとストア**: `mcp.servers` の schema と読み書き
3. **CLI アダプター**: 読み込み・差分・同期・状態判定
4. **Web UI**: 一覧・編集・Agent 割り当て・適用プレビュー

## Fixed

### 段階 1: Spike

- スクリプトは `spikes/mcp-manager.ts`、結果は `docs/spikes/mcp-manager.md`（既存の spike 資料の形式に合わせる。CLI の版番号を記録する）
- 実測する項目（CLI ごと）:
  - MCP 登録の設定ファイルの場所と形式（Claude: user scope と project scope `.mcp.json`、Codex: `~/.codex/config.toml`、agy: `~/.gemini/config/mcp_config.json`。これらは仮説。実物で確認する）
  - 登録・削除の公式コマンドの有無と挙動（`claude mcp add-json/remove`、`codex mcp add/remove`、agy の相当機能）。どのファイルがどう書き換わるか
  - 設定の置き場所を環境変数で差し替えられるか（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、agy は `HOME`/`USERPROFILE` 依存か）。テストと spike を実ユーザーの設定から隔離するために必須
  - `env` の値と環境変数参照（`${VAR}` 等）の対応の有無
  - http transport の書き方（Codex は `mcp_servers.<name>.url` が使える実績あり。§12・`src/agents/codex-adapter.ts` 参照）
- **実ユーザーの設定ファイル（`~/.claude.json`・`~/.codex/config.toml`・`~/.gemini/`）を spike で書き換えない**。環境変数で一時フォルダに向けて実測する。向けられない CLI は、先にファイルをコピーして退避し、終了時に戻す
- **モデルのターンを開始しない**（利用枠を消費しない）。`mcp list` 系の確認コマンドまでとし、会話を開始しないと確認できない項目は「未確認」と記録して先へ進む

### 段階 2: 内部モデルとストア

- `src/config/config.ts` の schema に `mcp` キーを追加する:

```ts
mcp: z.strictObject({
  servers: z.record(z.string().min(1), serverSchema).optional(),
}).optional()
```

- サーバーの形（`serverSchema`）:
  - `transport`: `"stdio" | "http"`
  - `command?: string` / `args?: string[]`（stdio のとき必須: command）
  - `url?: string`（http のとき必須）
  - `env?: Record<string, string>`（秘密でない値のみ）
  - `envRefs?: Record<string, string>`（キー → 参照する環境変数名。値そのものは保存しない）
  - `enabled: boolean`
  - `agents: { claude?: boolean; codex?: boolean; gemini?: boolean }`（キーは `AGENT_IDS`。`agentRecord` を使う。元提案の `antigravity` ではなく `gemini`）
- 置き場所と重ね方は既存の設定と同じ: グローバル `~/.clodex/config.json`、プロジェクト `<root>/.clodex.json`。`mcp.servers` は名前ごとにプロジェクトが優先（`OBJECT_CONFIG_KEYS` の重ね方に倣うが、servers はサーバー名単位でマージする）
- サーバー名 `clodex` は予約。schema で拒否する（Coordinator の formal message 用。§12）
- UI からの保存は該当スコープのファイルの `mcp` キーだけを差分更新する（他のキー・ユーザーの手書き設定を壊さない）。書き込みは `writeFileAtomic`

### 段階 3: CLI アダプター

- 新しいディレクトリ `src/mcp-manager/` に置く。Coordinator・AgentAdapter には依存しない（依存の向き: web/hub → mcp-manager → config）
- アダプター interface（名前は裁量）: CLI ごとに
  - `read()`: CLI の設定から MCP 登録の一覧を読む（壊れたファイルはエラーとして状態に出す。例外で落とさない）
  - `plan(desired)`: 望む状態（内部モデルで enabled かつその CLI に割り当てたサーバー）と現状の差分を返す（追加・更新・削除・未対応）
  - `apply(plan)`: 差分だけを書き込む
- 書き込みの決まり:
  - **Clodex 管理対象だけを差分更新**する。CLI 側にだけある登録（外部管理）は読み取りのみで、削除・変更しない
  - 削除するのは「以前 Clodex が書いたが、内部モデルから消えた・無効化された」もののみ。Clodex が書いた印として、適用済みサーバー名の一覧をスコープごとの内部状態（`~/.clodex/mcp-applied.json`）に記録し、それに載っている名前だけ削除してよい
  - 適用の前に対象ファイルを読み直す（プレビュー時点から外部変更があれば適用を中止してエラーを返す）
  - 適用の直前にバックアップ（`<file>.clodex-bak`、上書き）を取り、atomic に書く
  - Codex の `config.toml` はコメント・未知のキーを保てる手段で更新する（spike の結果で、公式コマンド経由か、保てる書き方が確認できた場合のみ直接編集）。保てる手段が無ければその旨を返して書き込まない
  - agy は `src/agents/agy-mcp-config.ts` と同じファイルを触る。`clodex`（proxy）の登録を壊さない。共通化してよい
  - 未対応項目（例: その CLI が http に未対応、envRefs の展開に未対応、project scope が無い）は警告として plan に含め、黙って省略しない
- 状態判定（サーバー × CLI）: `synced / missing / mismatch / unsupported / external`。接続・認証の成否は判定しない（UI では「未確認」扱い）
- パス・環境変数はすべてコンストラクタ等で注入可能にし、ユニットテストは一時フォルダで実ファイル読み書きを検証する。**実ユーザーの設定に触れるテストを書かない**

### 段階 4: Web UI

- Web UI にシート「MCP」を追加する（`src/web/client/` の既存シートの流儀。設定系 UI は `agent-settings.ts` を参考にする）
- 表示: サーバーの一覧（名前・transport・スコープ・CLI ごとの状態バッジ）、外部管理の登録も一覧に出す（読み取りのみの印）
- 編集: 追加・編集・削除・`enabled`・Agent 割り当てのトグル。保存は内部モデルへ
- 適用: 「適用」操作で CLI ごとの差分（追加・更新・削除・警告）をプレビューに出し、確認してから書き込む。結果（成功・エラー）を表示する
- 反映は各 CLI の次回起動からである旨を短く示す（起動中の Agent の再起動はしない）
- UI 文言はリポジトリの流儀（体言止め・短く。CLAUDE.md の UI 文言ルール）と既存の i18n の仕組みに従う
- サーバー側は web-server に `/api/mcp` 系のエンドポイントを追加する（形は裁量）。プロジェクトのスコープは今開いている会話のプロジェクトを使う

### テスト方針

- 段階 2: config の schema・マージ（プロジェクト優先・`clodex` 拒否）のユニットテスト
- 段階 3: アダプターごとに一時フォルダで read / plan / apply / 外部変更検出 / バックアップのユニットテスト。spike で確認した実ファイル形式を fixture にする
- 段階 4: 既存の client テストの流儀で、一覧・編集・プレビューの描画と API 呼び出しのテスト
- 実 CLI を起動する E2E は書かない（spike で代替）

### 編集してよいファイル

- `spikes/mcp-manager.ts`、`docs/spikes/mcp-manager.md`（新規）
- `src/config/config.ts`・`config.test.ts`
- `src/mcp-manager/`（新規）
- `src/agents/agy-mcp-config.ts`・同テスト（共通化する場合）
- `src/web/web-server.ts`・`web-ui.ts`・`src/web/client/`（シート追加に必要な範囲）と各テスト
- i18n の文言ファイル（既存の置き場所に従う）

`docs/DESIGN.md`・`docs/specs/` は編集しない（設計の変更が要るときは QUESTION）。

## Discretion

- アダプター interface の細部・型名・エラーの表現
- 書き込み手段の選択（公式コマンド経由か直接編集か）は spike の結果で決める。ただし「段階 3 の書き込みの決まり」を満たすこと
- `/api/mcp` エンドポイントの形、UI のレイアウト・コンポーネント分割
- `mcp-applied.json` の形式
- TOML ライブラリの採否（コメント保持の制約を満たす範囲で）
- spike で「未確認」になった項目の扱い（該当機能を `unsupported` に倒すのは可）

## 注意

- Claude の設定（`~/.claude.json` 相当）は Claude Code 自身が常時書き換える大きな状態ファイルの可能性がある。spike で場所と排他の挙動を確かめ、危険なら user scope の書き込みは公式コマンド経由に限定してよい
- 段階ごとに `pnpm test` と `pnpm typecheck` を通す。最後に `pnpm lint` も確認
