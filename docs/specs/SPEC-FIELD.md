# SPEC-FIELD: formal message に `spec` を追加する

設計の正は `docs/DESIGN.md` §11（Message Schema）、§13（Context Resolver・Spec・Roles）、§28 v0.3 B（成果物）。この文書は実装の範囲と受入条件をまとめる。

## 変更

1. `src/protocol/messages.ts`
   - 任意の `spec: string`（空文字は不可）を追加する。describe は英語で「Path (relative to the project root) of the design document for this request. Write the design there first; keep body short」程度
   - `DELEGATE` / `REVIEW_REQUEST` 以外の type に `spec` があれば schema で拒否する
2. 送信時の存在確認（`src/mcp/server.ts` か Coordinator のどちらか、既存の検証の置き場所に合わせる）
   - project root からの相対パスとして解決し、通常ファイルとして存在しなければ拒否して tool のエラーで返す（Agent が書き忘れたまま送るのを防ぐ）
   - project root の外（`..`、絶対パス、symlink で外に出るもの）も拒否する。実パスで確かめる。`/api/file` の範囲チェック（§28 v0.3 B）に既存の関数があれば再利用する
3. `src/context/context-resolver.ts`
   - `Commit:` の次、`Files:` の前に `Spec: <path>` を出す
   - `spec` があれば、本文の後・返信方法の前に次の 1 行を足す（文言は定数にする）
     `Read the spec before you start and follow it. If the spec conflicts with the code or is unclear, ask with a QUESTION instead of guessing.`
4. `src/context/role-instructions.ts`
   - 役割の有無にかかわらず、次の趣旨の英語の定型文を 1 行追加する（定数にする）
     「DELEGATE / REVIEW_REQUEST は、まず設計書を書き（既定 `docs/specs/<taskId>.md`）、`spec` に指定する。body は要約だけ。body だけにするのは数行で説明しきれる簡単な依頼に限る」
5. 表示
   - Web UI の message 表示（`src/web/client/client-main.ts` の refs）: `spec` を `files` より前に出し、選ぶとビューアで開く。spec と分かる見た目にする（ラベル「設計書」/ "Spec" を i18n に追加）
   - 成果物一覧（`src/web/client/artifacts.ts`）: `spec` も「参照」として加える
   - 端末・event log の表示（`src/logging/event-log.ts` の `formatMessage`）: `files` を出しているなら同じ形で `spec` も出す。出していなければ変更しない

## テスト（先に書く）

- schema: DELEGATE / REVIEW_REQUEST で `spec` を受理、RESULT などでは拒否、空文字は拒否
- 存在確認: 存在するファイルは受理、存在しない・ディレクトリ・project root の外は拒否
- envelope: `Spec:` 行と指示の 1 行が出る。`spec` が無いときは出ない
- role instructions: 定型文が役割あり・なしの両方に入る
- artifacts: `spec` が参照として一覧に入る

## 受入条件

- `pnpm test` と `pnpm typecheck` が通る
- E2E は実行しない
