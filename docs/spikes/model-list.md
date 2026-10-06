# model の一覧と利用枠（2026-10-06）

スクリプト: `spikes/model-list.ts <claude|codex>`。Claude Code 2.1.290、codex-cli 0.156.1 で実測した。どちらもターンを送らないので API 呼び出しも利用枠の消費もない。

## Claude

- `claude -p --input-format stream-json --output-format stream-json --verbose` に `{ type: "control_request", request_id, request: { subtype: "initialize" } }` を送ると、`control_response.response.response.models` に一覧が返る
- 要素は `{ value, resolvedModel, displayName, description, supportsEffort?, supportedEffortLevels?, ... }`。`value` が `/model` に渡す値
- 実測した一覧（先頭のみ）:

| value | resolvedModel | displayName | description |
|---|---|---|---|
| `default` | `claude-opus-5-5` | `Default (recommended)` | `Opus 5.5 · Best for everyday, complex tasks` |
| `opus` | `claude-opus-5-5` | `Opus 5.5` | |
| `fable` | `claude-fable-5-1` | `Fable 5.1` | |
| `sonnet` | `claude-sonnet-5-5` | `Sonnet 5.5` | |
| `haiku` | `claude-haiku-4-5-20251001` | `Haiku 4.5` | |
| `claude-sonnet-5` など | 同じ | `Sonnet 5` など | 旧版。Opus 4.6 まで続く |

- `default` の `displayName` には版が無い。版は `description` の ` · ` より前にある

## Claude の利用枠

- 同じプロセスに `{ type: "control_request", request_id, request: { subtype: "get_usage" } }` を送ると、`response.response.rate_limits` が返る（`get_rate_limits` / `rate_limits` / `usage` は `Unsupported control request subtype`）
- `five_hour` / `seven_day` が `{ utilization, resets_at, ... }`。実測: `{ utilization: 26, resets_at: "2026-10-06T02:39:59.533754+00:00" }`。utilization は 0〜100 の percent、resets_at は ISO 8601（ターン中の `rate_limit_event` は比率と epoch 秒なので形式が違う）
- ほかに `limits[]`（`kind: session / weekly_all / weekly_scoped`、`percent`、model 別の週枠など）や `extra_usage` がある
- 参考: user message の `/usage` も API 呼び出しなし（usage 0、cost 0）で同じ内容を文章で返すが、構造化されていないので使わない

## Codex

- `codex app-server` に `initialize` → `initialized` → `model/list {}` を送ると、`result.data[]` と `nextCursor`（今回は `null`）が返る。thread を始めなくても取れる
- 要素は `{ id, model, displayName, description, hidden, isDefault, supportedReasoningEfforts, defaultReasoningEffort, ... }`。`model` が `turn/start` の値
- `account/rateLimits/read`（params なし）も thread なしで取れる。`result.rateLimits.primary` が `{ usedPercent: 2, windowDurationMins: 10080, resetsAt: 1791846154 }`、`secondary` は null（このアカウントは週枠のみ）
- 実測: `gpt-6-astra`（`GPT-6-Astra`, isDefault）、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。`hidden` はすべて false

## 結論

両 Agent とも、短命のプロセスを起動して model の一覧と利用枠を取得できる。Agent の Lazy Start を待たずに Clodex の起動時に取得する。
