# CONFIG-LAYERS: 設定の層を正し、共通の作法 `rules` を足す

project の `.clodex.json` に `roles` の片方だけを書くと、`loadConfig` が浅い上書きのためもう片方（ユーザーの設定）が消える。設定をキーごとに重ね、役割とは別に Agent ごとの共通の作法 `rules` を足し、実効値と設定元を画面に出す。仕様の正は `docs/DESIGN.md` §13 Roles の「設定の層」と `rules`・設定元の項。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、Web UI の設定・役割のシート、TUI、テスト）は確認せずに触ってよい。

1. **設定の層**（`src/config/config.ts`）
   - schema に `rules: { claude?: string, codex?: string }` を足す。空文字は未設定（`roles` と同じ扱い）
   - `loadConfig` を DESIGN の「設定の層」どおりに重ねる
     - オブジェクトの設定（`roles`・`freshThread`・`usageHints`・`limits`・`worktree`・`web`・`usageAlert`）は 1 段下のキーごとに上書き
     - `threadTokenWarn` は両方オブジェクトのときだけキーごと。どちらかが数なら project の値
     - `rules` は Agent ごとに user → project の順に改行でつなぐ
     - ほかは project で上書き
   - 設定元を返す関数を足す（例: `loadConfigLayers(paths)` が `{ config, sources }` を返し、`loadConfig` はその `config` を返す）
     - `sources.roles[agent]`: `"user" | "project"`（実効値の出どころ。無ければ無し）
     - `sources.rules[agent]`: `{ source: "user" | "project"; text: string }[]`（層ごと。空は含めない）
   - 先頭コメントの「トップレベルのキー単位に上書きする」を今の仕様に直す
2. **定型文**（`src/context/role-instructions.ts`）
   - `buildRoleInstructions` に Agent の `rules`（実効値の文字列）を渡せるようにし、役割の行（`roleLines`）の直後に `Rules: <text>` を入れる（複数行はそのまま）。役割が無い Agent でも rules があれば入れる
   - ブレスト（`brainstorm: true`）には入れない
   - 呼び出し元（`src/hub/project-context.ts` の `buildRoleInstructions(id, config.roles, …)`）から `config.rules?.[id]` を渡す
3. **保存後の読み直し**（`src/index.ts` の `/role` 保存の後 `context.config.roles = { ...context.config.roles, [agent]: saved }` の箇所と `/role preset`）
   - 部分的に書き換えず、`loadConfig` / 設定元の関数で読み直して実効値と設定元を更新する。起動オプションで上書きしている値（`primary`・`permission` など）があれば、今どおり起動オプションを優先する（読み直しで失わないこと）
4. **表示**
   - `/role`（`src/cli/shell.ts` の `handleRole`）: 役割の後に設定元（ja/en とも `(project)` / `(user)`）。続けて `rules` を設定元ごとに 1 行ずつ（例: `rules (user): …`）。`roles` / `rules` の取得は shell の options に設定元付きの関数を渡す形にしてよい
   - Web UI: state（`src/web/web-feed.ts` の `roles` の隣）に `roleSources` と `rules`（層ごとの配列）を足す。役割のシート（`src/web/client/agent-settings.ts`）の役割の見出しの横に設定元の小さな印（ja「ユーザー」/「プロジェクト」、en "User" / "Project"）。役割の欄の下に `rules` を読み取り専用で層ごとに出す（印 + 本文。無ければ何も出さない）。編集の UI は作らない
   - 文言は短く（CLAUDE.md の UI 文言の方針）。説明文を足さない

## テスト方針

- `src/config/config.test.ts`
  - project に `roles.codex` だけ → user の `roles.claude` が残る。設定元が `claude: user` / `codex: project`
  - `rules`: user と project の両方 → 改行でつながる。層ごとの配列と設定元。空文字は無視
  - `limits` などのオブジェクトのキーごとのマージ。`threadTokenWarn` の数とオブジェクトの組み合わせ
  - 既存の「トップレベルのキー単位で上書きする」テストは新しい仕様に書き換える
- `src/context/role-instructions.test.ts`: rules が役割の行の直後に入る。役割が無くても入る。ブレストには入らない
- `src/cli/shell.test.ts`: `/role` の出力に設定元と rules が出る
- Web の state に `roleSources`・`rules` が入る（既存の web-feed / server のテストの形に合わせる）
- 画面は CLAUDE.md の「画面の確認（Web UI）」の手順で一時の Hub を立て、user と project の両方に役割と rules を書いた状態で役割のシートのスクリーンショット（PC とスマホ幅）を `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に撮り、RESULT に path を書く
- 最後に `pnpm test`・`pnpm typecheck`・`pnpm lint` を 1 回ずつ。コミットはしない

## 触ってよいファイル

- `src/config/**`、`src/context/role-instructions.ts`（とテスト）、`src/hub/project-context.ts`、`src/index.ts`、`src/cli/shell.ts`（とテスト）、`src/web/web-feed.ts`、`src/web/client/**`、`src/i18n/messages.ts`、`src/tui/**`（型の追従が要る場合）
- 生成コマンド（`pnpm build` など）が書き換えるファイル
- `docs/DESIGN.md` は触らない（矛盾を見つけたら QUESTION）
