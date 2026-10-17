# BOILERPLATE: 定型文と envelope の作法を直し、重複を削る

QUESTION の往復（DELEGATE の 44% で発生）と、毎ターン送り直す定型文の token を減らす。Agent に渡す固定の文章だけを変える。Coordinator の挙動は変えない。仕様の正は `docs/DESIGN.md` §13 Roles の「定型文の作法」と `usageHints`、§13 Context Resolver の envelope の説明と例、§28 F ブレストの「重ねる」「まとめる」。

## 固定（挙動・不変条件・編集範囲）

- 定型文・envelope・ブレストのプロンプトは英語のまま。`any` を使わない。文字列は定数にする
- 編集してよいファイル: `src/context/role-instructions.ts`・`src/context/context-resolver.ts`・`src/coordinator/brainstorm.ts` とそれぞれのテスト、文言の変更で落ちる他のテスト（期待値の追従だけ）
- `docs/DESIGN.md` は触らない（矛盾を見つけたら QUESTION）

## 変更

1. **QUESTION の書式**（`role-instructions.ts`）: 定型文に 1 行足す。`Write a QUESTION body in three lines: "Decide:" (what you need decided), "Blocked:" (work waiting for the answer), "Continuing:" (work you continue meanwhile). Stop work that depends on the answer.`
2. **設計書の節**（`SPEC_NOTE`）: 末尾に足す。`Split the spec into "Fixed" (behavior, invariants, public interfaces, files that may be edited) and "Discretion" (what the implementer may decide). Before doing anything against a Fixed section, ask with a QUESTION.`
3. **RESULT の後の最終応答**: 定型文に 1 行。`After sending RESULT with send_message, keep your final reply to one line.`
4. **usageHints**（`USAGE_NOTE`）: 末尾に足す。`Do not re-read content you already read. Do not rerun the same tests or type checks when nothing has changed.`（`usageHints` が ON のときだけ。今どおり）
5. **envelope の重複**（`context-resolver.ts`）: `replyInstruction` の最後の `BODY_FORMAT` を消す（定型文の `BODY_FORMAT` は残す）。言語の行（`languageDirective`）は残す
6. **ブレスト**（`brainstorm.ts`）
   - `roundPrompt`: 両方の周に、案に ID を付ける指示を足す（Claude は `C1`・`C2`…、Codex は `X1`・`X2`…。周をまたいで通し番号。2 周目以降は相手の案を ID で指して批評する）。Agent ごとの接頭辞は定数の対応表にする
   - `summaryPrompt`: 案の一覧を表にする指示に変える。列は `ID | Proposer | Status | Basis`、Status は `adopted` / `adopted with changes` / `on hold` / `rejected`、Basis は実測・コード・相手の批評など。論点・有望な案と理由・未解決の問いは今どおり

## 裁量

- 各文の細かい言い回し・定型文の中での並び（役割の行と `Rules:` の直後に置くことだけは守る）

## テスト方針

- `role-instructions.test.ts`: 3 つの新しい行（QUESTION の書式・設計書の節・RESULT の後の 1 行）が入る。ブレストには入らない。`usageHints` の追加文は ON のときだけ
- `context-resolver.test.ts`: 依頼系の envelope に `BODY_FORMAT` が無く、言語の行は残る
- `brainstorm.test.ts`（無ければ作る）: ID の接頭辞の指示と、まとめの表の列
- 最後に `pnpm test`・`pnpm typecheck`・`pnpm lint` を 1 回ずつ。コミットはしない
