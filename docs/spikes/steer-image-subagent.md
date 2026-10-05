# Steer・画像の入力・Codex の subagent（2026-10-06）

スクリプト: `spikes/steer-image-subagent.ts <claude|codex> <steer|image|subagent>`。Claude Code 2.1.289（haiku）、Codex app-server 0.156.1（gpt-6-sol）で実測した。

## 実行中ターンへの追加入力（steer）

| | 送り方 | 結果 |
|---|---|---|
| Claude | 実行中に stdin へ通常の `{"type":"user",...}` をもう 1 行送る | 実行中の tool（`sleep 8`）が終わった時点で取り込まれ、残りの作業をやめて `STEERED` と答えた。`result` は 1 つだけ（`num_turns: 2`）。新しいターンにはならない |
| Codex | `turn/steer`（`threadId`、`expectedTurnId` = 実行中の turn ID、`input`） | 応答は `{ turnId }`。モデルが一連の command（3 回の `sleep 8`）を終えた後、`userMessage` item として取り込まれ、`STEERED` と答えた。`turn/completed` は 1 つ |

- どちらも「途中で取り込まれる」が、取り込まれるのは実行中の tool / command の区切り。即時ではない
- Codex は実行中のターンが steer できない種類（compact 等）だと `activeTurnNotSteerable` の error になる（型定義の `CodexErrorInfo`）

## 画像の入力

| | 送り方 | 結果 |
|---|---|---|
| Claude | user message の `content` を配列にし、`{"type":"image","source":{"type":"base64","media_type":"image/png","data":...}}` と text を並べる | 赤一色の PNG の色を「赤」と答えた |
| Codex | `turn/start` の `input` に `{"type":"localImage","path":"<絶対パス>"}` と text を並べる | 「Red」と答えた |

- 壊れた PNG を送ると、Claude は `API Error: an image in the conversation could not be processed` を発言として返し、ターンは成功扱いのまま続いた

## Codex の subagent

- `codex features list` で `multi_agent` は stable・有効（既定）。Agent は自分の判断で subagent を起動できる
- subagent は別の thread で動く。その thread の `turn/started`・`item/*`・`turn/completed`・`thread/status/changed` が、同じ app-server の stdout に `threadId` 付きで流れる
- 親の thread には `subAgentActivity` item（`kind: "started" | "completed"`、`agentThreadId`、`agentPath`）が出る

結論: Codex Adapter は `threadId` が自分の thread でない通知を無視しなければならない（無視しないと、subagent の `turn/completed` で親のターンが subagent の応答で終わってしまう）。subagent の様子は親の `subAgentActivity` を tool として出す。
