# Model / Effort の切り替え（2026-10-06）

スクリプト: `spikes/model-effort.ts`。Claude Code 2.1.289、Codex app-server 0.156.1 で実測した。

## Claude

- `--model haiku --effort low` の stream-json 起動後、`system/init.model` は `claude-haiku-4-5-20251001`。`effort` フィールドは無い（`per_turn_effort_active: false` は effort の値ではない）
- `control_request` の `{ subtype: "set_model", model: "haiku" }` は `control_response` の `success`。次ターンの `system/init.model` も `claude-haiku-4-5-20251001`
- `{ subtype: "set_effort", effort: "medium" }` は `Unsupported control request subtype: set_effort`。後述の slash command を追加実測して反映方法を決めた
- 存在しない model の `set_model` は `catalog_unknown` / `Model '...' not found` の error 応答。CLI は従来 model のまま次ターンを実行した
- `spikes/claude-invalid-model.ts` で、haiku のターン後に同じ session を `-r` と不正な `--model` で再起動すると、`result` は `is_error: true`、`subtype: "success"`、API error 404、プロセス終了コード 1 だった。Adapter は `is_error` から turn を failed にできる

## stream-json の slash command（追加実測）

`spikes/model-effort.ts claude --slash`。CLI の既定 model は Opus、最初の API 呼び出し前に `/model haiku` を送った。

| 入力 | result | is_error | このターンの usage | 次ターンの init.model |
|---|---|---|---|---|
| `/model haiku` | `Set model to Haiku 4.5 for this session only` | false | input/output とも 0、cost 増分 0 | `claude-haiku-4-5-20251001`（変更前は `claude-opus-5-5`） |
| `/effort high` | `Set effort level to high (this session only)` で始まる | false | input/output とも 0、cost 増分 0 | Haiku のまま |
| `/model no-such-model` | `Model 'no-such-model' not found` | false | input/output とも 0、cost 増分 0 | Haiku のまま |
| `/effort bogus` | `Invalid argument: bogus. Valid options are: ...` | false | input/output とも 0、cost 増分 0 | Haiku のまま |

各 slash command はそれぞれ `system/init` → `result` の 1 ターンになった。effort の値は init に出ないが、`result` が設定成功を明示した。無効値も `subtype: success` / `is_error: false` なので、結果文を確認して failed に変換する。

結論: Clodex は model / effort の変更を mailbox の 1 ターンとして直列に送り、CLI の slash command を使う。API 呼び出しは発生せず、プロセス再起動も不要。

## Codex

- 生成型 `v2/TurnStartParams.ts` の `model` / `effort` は「このターンと以降のターンを上書き」と定義されている
- `thread/start` 応答には `model: "gpt-6-sol"`, `reasoningEffort: "medium"` があった。`thread` 本体にも両方ある
- `turn/start` に `model: "gpt-6-sol"`, `effort: "low"` を指定したターンは成功。次の `turn/start` では両方を省略して成功し、その後の `thread/read` と別プロセスの `thread/resume` 応答は `model: "gpt-6-sol"`, `reasoningEffort: "low"`。値が次ターンと再開後にも引き継がれた
