# Spike G — 手動 compact

スクリプト: `spikes/compact.ts`（Claude Code 2.1.289 / codex-cli 0.156.1、2026-10-05）

合言葉を覚えさせ、長い文章でコンテキストを増やしてから compact し、合言葉を覚えているかを確認した。

## 検証結果

| Agent | 方法 | 結果 |
|---|---|---|
| Claude | stream-json に `{"type":"user","message":{"role":"user","content":"/compact"}}` | `system/status`（`compact_result: "success"`）→ `system/compact_boundary`（`trigger: "manual"`、`pre_tokens: 30285`、`post_tokens: 3299`）→ 要約の user メッセージ → `result`（`result: ""`）。1 ターンとして完了する。compact 後も合言葉を覚えていた |
| Codex | `thread/compact/start { threadId }` | 応答は `{}`。その後 **1 つのターンとして** 動き、`thread/tokenUsage/updated`（`last.totalTokens` 17402 → 5178）→ `item/completed`（`type: "contextCompaction"`）→ `turn/completed`。compact 後も合言葉を覚えていた |

## 注意点

- Claude の `post_tokens` は会話部分だけで、system prompt 等（haiku で約 25k）を含まない。compact 直後の正確なコンテキストの大きさは次のターンの usage まで分からない
- Codex の compact はターンなので、他のターンと並行して送れない。compact 中は `turn/interrupt` の対象にもなる
- Codex の compact ターンには agentMessage が無い

## 結論

両 Agent とも手動 compact を実行できる。Clodex では compact を 1 つのターンとして扱い、通常の送信と同じ mailbox で直列に送る。
