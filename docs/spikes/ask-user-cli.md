# ask_user の Claude CLI 引数確認

2026-10-06、Windows ネイティブ環境で `claude --help` を実行。

- `--allowedTools, --allowed-tools <tools...>`: 許可する tool 名をカンマまたは空白区切りで指定できる。
- `--disallowedTools, --disallowed-tools <tools...>`: 拒否する tool 名をカンマまたは空白区切りで指定できる。
- Adapter は許可リストに `mcp__clodex__send_message,mcp__clodex__ask_user`、拒否リストに `AskUserQuestion` を渡す。

help の確認と fake process による起動引数のユニットテストのみ。実 Agent による tool 呼び出しの E2E は未実行。
