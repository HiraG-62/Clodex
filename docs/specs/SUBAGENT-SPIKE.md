# SUBAGENT-SPIKE: Claude の裏のサブエージェントの始まりと終わりを実測する

本体のエージェントが手を空けると、裏でサブエージェントが動いていても「作業完了」に見え、サブエージェントの状態が分からない。Clodex でサブエージェントの状態を出すため、Claude Code の stream-json で、裏のサブエージェントの始まり・終わり・いくつ動いているかを取れるイベントを実測する（CLAUDE.md: CLI の挙動に依存する変更は推測で実装せず spikes で実測し、`docs/spikes/` に記録する）。人の了承は取得済み。haiku で最小限に行う。

Codex は実測済み（`docs/spikes/steer-image-subagent.md`: 親の thread の `subAgentActivity` の `started` / `completed`）なので対象外。

## 実測すること

`spikes/claude-stream.ts --background`（既存）を広げるか、新しいスクリプトにする。haiku で、`run_in_background: true` の Agent tool を **2 つ**（終わる時刻をずらす。例: 片方はすぐ、片方は少し待ってから返す）起動させ、本体はすぐターンを終える。stdout の **全イベントの生の JSON** をファイルに残す（`type`・`subtype`・`parent_tool_use_id`・`tool_use_id` など全フィールド）。

確かめたいこと:

1. 起動: 本体の `assistant` の Agent の `tool_use`（`id`・`input.description`・`input.run_in_background`）。起動直後に返る `user` の `tool_result` の中身（task の ID などがあるか）
2. 動いている間: サブエージェントの `assistant`（`parent_tool_use_id`）以外に、状態を示すイベント（`system` の `task_started` / `task_progress` などの subtype）があるか
3. 終わり: サブエージェントが終わったことを示すイベント（`system` の subtype、`user` の `tool_result`、本体に渡る通知の本文の形など）。どの ID で起動時と結び付くか
4. 本体の自発ターン（`system/init` → `assistant` → `result`）との順序。2 つ目が終わる前に本体のターンが始まったときの見え方
5. `/interrupt`（control_request の interrupt）やプロセス終了でサブエージェントがどうなるか（簡単に見られる範囲で。無理なら省く）

## 記録

- `docs/spikes/claude-subagent.md` に、上の 1〜5 の結果を表か箇条書きで書く（CLI の版、使ったモデル、スクリプトのパスと引数）。生ログの抜粋は必要な分だけ（長いものは要約）
- 最後に「結論: Clodex はどのイベントで、サブエージェントの始まり・終わり・数を取れるか」を書く
- `docs/spikes/README.md` に一覧の行があれば足す

## 守ること

- 実行は 1〜2 回、haiku のみ。プロンプトは短く、サブエージェントには短い応答だけさせる
- プロダクトのコードは変えない（`spikes/` と `docs/spikes/` だけ）
- 終わったら `send_message` の RESULT で、結論の要約と記録のパスを報告する。コミットはしない
