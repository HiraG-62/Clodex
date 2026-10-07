# 割り込み（steer）を取り込んだ時点の検知（2026-10-08）

スクリプト: `spikes/steer-ack.ts <claude|codex> <tool|text>`。Claude Code（haiku）、Codex app-server 0.156.1 で実測した。`tool` は `sleep 8` を 3 回実行している最中に、`text` は tool を使わず長文を書いている最中に割り込む。

## Claude

- `--replay-user-messages` を付けると、user message を取り込んだ時点で `{"type":"user","isReplay":true,"uuid":...}` が出る。uuid は送った行の `uuid` と同じ（送り手が UUID を付けて照合できる）
- `tool`: 6.0 秒に送った割り込みは、実行中の tool の結果（13.4 秒）の直後、13.5 秒に replay された。`result` は 1 つ（`num_turns: 2`）
- `text`: 4.0 秒に送った割り込みは、そのターンでは取り込まれなかった。最初のターンの `result`（16.1 秒）の後に `system init` が出て、次のターンとして 18.9 秒に replay された。`result` は 2 つ
- 送った直後には、割り込みに対応する出力はない（`command_lifecycle` だけ）

## Codex

- `turn/steer` の応答（`{ turnId }`）は送った直後に返る。取り込んだ時点で、そのターンの中に `item/started` の `userMessage`（中身は割り込みの本文）が出る。item に送り手の ID は無い
- `tool`: 6.9 秒に送った割り込みは、モデルが 3 回の command を終えた後、31.4 秒に `userMessage` として取り込まれた
- `text`: 4.2 秒に送った割り込みは、長文の `agentMessage`（33.6 秒に完了）の後、33.7 秒に同じターンの中で取り込まれ、続けて `STEERED` と答えた。`turn/completed` は 1 つ
- ターンの最初の `userMessage` は、そのターンの入力そのもの。2 つ目以降が割り込みで、送った順に取り込まれる

## 結論

どちらも、割り込みを取り込んだ時点を検知できる。Claude は replay の uuid、Codex はターンの 2 つ目以降の `userMessage` を、送った順に割り込みと対応付ける。Claude は区切りが無いまま終わったターンでは、割り込みを次のターンとして取り込む。
