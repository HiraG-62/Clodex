# README-UPDATE: README を今の機能に合わせる

`README.md` は v0.1 の CLI の説明のまま。ほかの PC・人が使い始められるよう、今の機能に合わせて書き直す。設計の正は `docs/DESIGN.md`。README は使い方の入口に絞り、詳細は DESIGN.md の節へリンクする。

## 構成（この順）

1. 概要（1〜2 行。今のままでよい）
2. 前提: Windows 11、Claude Code CLI と Codex CLI がサブスクリプションでログイン済み。API key の環境変数は Agent に渡さない
3. インストール
   - GUI（推奨）: `pnpm gui:build` で作るインストーラー（`gui/src-tauri/target/release/bundle/nsis/`）。Node や `clodex` の PATH は要らない。閉じるとトレイに残り、終了はトレイのメニュー。通知（作業終了・通知・エラー）。詳しくは `gui/README.md`
   - CLI: `pnpm install` → `pnpm build` → PATH の shim（今の説明を残す）
4. 起動
   - GUI を起動するか、project で `clodex`（TUI。Hub が動いていればそれにつなぐ）。`clodex serve`（画面なしの Hub）、`clodex --web`
   - project の切り替え（`/project`、GUI はフォルダ選択）、会話（`/new`、`/new worktree`、`/resume`）
5. 入力（表）: `src/cli/commands.ts` と `/help` の一覧から作る。`@claude` / `@codex` / `@all`、`@agent!`（割り込み）、`@<path>`（ファイルの参照）、`!command`、`!& command`、主なスラッシュコマンド（`/processes`・`/kill` を含む）。今の表のうち古い説明は直す
6. 設定ファイル: `~/.clodex/config.json`（全 project の既定）と project の `.clodex.json`（トップレベルのキー単位で上書き）。キー: `roles`、`primary`、`permission`、`language`、`limits`、`web`、`usageAlert`。例として `roles` の書き方を 1 つ（中身は短い例でよい。実際の文面は載せない）。`/role` で project の役割を書き換えられること
7. スマホから使う: Hub は 127.0.0.1 だけで待ち受ける。Tailscale を PC とスマホに入れ、`tailscale serve --bg 4319`、初回は `https://<PC 名>.<tailnet>.ts.net/?token=<~/.clodex/web-token>` を開く（cookie で以後は不要）。tailnet で Serve と HTTPS の有効化が要ること。Hub が動いている間だけつながる（GUI はトレイに残す）
8. 保存されるもの: `~/.clodex/`（state・logs・artifacts・uploads・hub.json・web-token）。Hub の再起動で配送待ちと作業中のターンが戻ること（DESIGN.md §18）
9. 開発: 今の `CLAUDE.md` のコマンド（`pnpm test`・`pnpm typecheck`・`pnpm build`、E2E は `CLODEX_E2E=1` で利用枠を使う）

## 決まり

- 日本語。UI の文言の方針（CLAUDE.md の「UI 文言」）ではなく、説明文として普通に書いてよい
- DESIGN.md と食い違わないこと。迷ったら DESIGN.md に合わせ、食い違いを見つけたら RESULT に書く
- コードは変えない。`pnpm test` は不要（変更が README だけなら）
- コミットはしない
