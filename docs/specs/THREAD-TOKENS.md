# THREAD-TOKENS: session の累計の入力 token を出し、大きくなったら警告する

Codex の 1 本の thread がコンテキスト 15〜24 万 token に張り付いて大量の使用量を使っていたことに、記録を集計するまで気づけなかった。今の session の大きさを画面に出し、閾値を超えたら `/new <agent>` を勧める。仕様の正は `docs/DESIGN.md` §14「session の大きさ」と §13 Roles の設定のキー（`threadTokenWarn`）。

## 変更

対象のファイルは目安。同じ目的に要るファイル（`src/i18n/messages.ts`、設定の読み込み、Web UI の利用状況のポップオーバー・右の列・スマホの Agent のシート、TUI、`/status`）は確認せずに触ってよい。

1. **Adapter**（`src/agents/claude-adapter.ts`・`codex-adapter.ts`、`agent-adapter.ts`）: 今の `context` event に、今の session の累計の入力 token（`inputTotal` など）を足す（または別の event）
   - Codex: `thread/tokenUsage/updated` の `total`（入力。キャッシュから読んだ分を含む値を使う。フィールドは今の spike の raw か app-server の型定義で確かめる）
   - Claude: ターンの結果（`result`）の usage の `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` を足していく。session が変わったら 0 から
2. **Coordinator / state**: Agent ごとに累計を持ち、state の Agent に入れる。session が変わったら 0（Claude）/ unknown（Codex は次の通知まで）
3. **警告**: 設定の `threadTokenWarn`（`~/.clodex/config.json` と `.clodex.json`。数か Agent ごとの数 `{ "claude": n, "codex": n }`。既定は無しで、無ければ警告しない）があり、コンテキストの大きさがそれを超えたら、その session で 1 回だけ warn の `toast`（ja「{agent} の文脈が {tokens} を超過。/new {agent} を検討」/ en 同じ方針）。session が変わったら再び警告できる。Web UI の Agent のカードのコンテキストのゲージ（とスマホのピルの円環）を、超えている間は警告の色にする
4. **表示**: 累計を Web UI の利用状況（ポップオーバーと右の列）・スマホの Agent のシート・TUI の下の行・`/status` に出す（例: ja「累計入力 1.2M」。数の書き方は今のコンテキストの表示に合わせる）
5. 文言は短く

## テスト方針

- Adapter: Codex の `thread/tokenUsage/updated` と Claude の `result` の usage から累計が出る。session が変わったら数え直す
- 警告: 閾値を超えたら 1 回だけ toast、session が変わったら再び。数と Agent ごとの数の両方の形。設定が無ければ警告しない
- `/status` と TUI の表示
- 画面は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、state に累計と閾値を超えたコンテキストを差し込み、PC のポップオーバーとカードのゲージ、スマホのシートのスクリーンショットを撮って RESULT に path を書く
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
