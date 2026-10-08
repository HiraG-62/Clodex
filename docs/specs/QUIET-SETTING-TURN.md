# QUIET-SETTING-TURN: Claude の model / effort の切り替えをログに出さない

`/model` / `/effort` で Claude に送る slash command のターンが、ログに Claude の枠（「Set model to Opus 5.5 for this session only」）として出る。Clodex は値を project ごとに保存しているので、「this session only」は食い違って見える。仕様の正は `docs/DESIGN.md` §9 Model / Effort の「反映の方法」。

## 変更

1. **設定用ターンはイベントを出さない**（`src/agents/base-agent-adapter.ts`、`src/agents/claude-adapter.ts`）
   - base に、`turn_started` と `turn` の event を出さずに 1 ターン送る protected の手段を足す（例: `sendQuietly(text)`。内部の `beginTurn` / `finishTurn` に「静かなターン」の印を持たせる）。Promise の結果・`status` の busy / idle の遷移・spontaneous turn の待ち合わせは今と同じ
   - `ClaudeAdapter.runSetting` はこれを使う。`result` の成功判定（`MODEL_SUCCESS` / `EFFORT_SUCCESS`）と `this[kind] = value` は今のまま
   - `usage` / `context` など設定用ターン以外の event は今と同じでよい（`result` の `emitContext` は残してよい）
2. **結果の表示**（`src/cli/shell.ts`、`src/i18n/messages.ts`）
   - 成功: `shell.model` / `shell.effort` の文言を「保存した」ことが分かる形にする。ja: `model を保存: {agent} → {model}`、`effort を保存: {target} → {level}`。en: `Saved model: {agent} → {model}`、`Saved effort: {target} → {level}`
   - 失敗（`status: "failed"`）: 今は何も出ない。`notify(result.text, "warn")` で CLI の返事を出す。保存はしない（今どおり）
   - Codex は今どおり（ターンを送らない）

## テスト方針

- `claude-adapter.test.ts`
  - `setModel` / `setEffort` の成功・失敗で、`turn_started` と `turn` の event が出ないこと（今の「不正な model / effort は … failed にする」の `events` の期待を、出ない形に直す）
  - 設定用ターンの後の普通のターンは今どおり `turn_started` / `turn` を出すこと
- `shell.test.ts`
  - `/model` 成功で「Saved model: …」を出す
  - `/model` 失敗で warn の通知に CLI の返事を出し、保存しない
- `pnpm test` と `pnpm typecheck` を通す。コミットはしない
