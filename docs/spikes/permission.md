# Spike F — 起動後の権限変更

スクリプト: `spikes/permission.ts`（Claude Code 2.1.289 / codex-cli 0.156.1、2026-10-05）

## 検証結果

| Agent | 方法 | 結果 |
|---|---|---|
| Claude | `-p --permission-mode default` で起動 | Write は `permission_denials` に入り、ファイルは作られない（`-p` では人に確認できないので自動拒否） |
| Claude | stdin に `{"type":"control_request","request_id":"<id>","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}` | `control_response` success。次のターンの `system/init` が `permissionMode: acceptEdits` になり、Write が成功 |
| Claude | 同じく `mode: "bypassPermissions"` | 起動時に `--allow-dangerously-skip-permissions` を付けておけば切り替えられ、Bash が確認なしで実行された |
| Codex | `thread/start` の `sandbox: "read-only"` | shell でのファイル作成は失敗 |
| Codex | `turn/start` の `sandboxPolicy: { type: "workspaceWrite", ... }` | そのターンで作成できた。**以降のターンも上書きした設定のまま**（毎ターン指定しなくてよい） |
| Claude | `--permission-mode plan` で起動し、`--allowedTools Write "Bash(echo:*)"` で許可済みにしたうえで Write と Bash を指示 | どちらも実行されず、project 内にファイルは作られない（Claude 自身の計画ファイルが `~/.claude/plans` に書かれるだけ）。`default` はユーザー設定の許可リストで書き込めてしまうため、read-only には `plan` を使う |

## 追記: Codex の sandbox と git（2026-10-05）

| 方法 | 結果 |
|---|---|
| `workspace-write` で `git add` / `git commit` | `fatal: detected dubious ownership`。Windows の Codex sandbox は別ユーザーとしてコマンドを実行するため |
| 同じく `git -c safe.directory=* ...` | `Unable to create '.git/index.lock': Permission denied`。`.git` は sandbox の書き込み対象外 |

Codex が `edit` のままでは commit できない。commit は Claude（Bash の許可が必要）、Codex を `full` にする、または人が行う。

## 結論

両 Agent とも、プロセスを再起動せずに権限を変えられる。Claude は即時、Codex は次のターンから反映される。
