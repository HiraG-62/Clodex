# コマンドの終了結果（2026-10-17）

## 実行

CLI: `codex-cli 0.156.1`、`Claude Code 2.1.300`。

空の一時ディレクトリを作業場所にして `spikes/command-exit.ts` を実行した。実 CLI は Claude 1 セッション（Bash を 2 回）、Codex 1 ターン（コマンドを 1 回）のみ。

```powershell
node --experimental-strip-types spikes/command-exit.ts claude <一時ディレクトリ>
node --experimental-strip-types spikes/command-exit.ts codex <一時ディレクトリ>
```

raw は `docs/spikes/command-exit-claude.raw.jsonl` と `docs/spikes/command-exit-codex.raw.jsonl`。

## Claude

- `exit 0`: `user.message.content` の `tool_result` に `tool_use_id`、`is_error: false`、`content: "(Bash completed with no output)"`。
- 成功の `tool_use_result` は `{ stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false }`。数値の終了コードはない。
- `exit 3`: `tool_result` に `is_error: true`、`content: "Exit code 3"`。`tool_use_result` はオブジェクトではなく `"Error: Exit code 3"` という文字列。
- いずれも `parent_tool_use_id: null`。`tool_use_id` は先行する Bash の `tool_use.id` に一致。

終了コードは構造化されていない。成功ではコード自体がなく、失敗では自由文と同じ文字列に入るため、文字列からの抽出や成功時の 0 の補完はしない。Claude の `tool_end` は `failed` に `is_error` を記録する。背景 Bash の起動結果にも同じ方針を適用し、終了コードは付けない。

## Codex

`exit 3` の `commandExecution` は `item/completed` に `id`、`command`、`cwd`、数値の `exitCode: 3` を持つ。成功のコード 0 は既存の `docs/spikes/background-task-codex.raw.jsonl` で確認済み。

Codex は completed の `tool` に終了コードをまとめて記録する。`exitCode: null` は未確定としてフィールドを省き、`tool_end` は出さない。
