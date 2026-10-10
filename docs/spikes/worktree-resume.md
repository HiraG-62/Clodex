# Spike T: 別の作業ディレクトリでの resume

実施日: 2026-10-10 / Windows 11 Pro 10.0.26200
CLI: Claude Code 2.1.293 / codex-cli 0.156.1
検証スクリプト: `spikes/worktree-resume.ts`（`pnpm tsx spikes/worktree-resume.ts <claude|codex>`）

一時フォルダに A と B を作り、A で session を始めて合言葉を覚えさせ、B で resume して合言葉と作業ディレクトリを答えさせた。

## 結果

| Agent | 方法 | 結果 |
|---|---|---|
| Claude | A で `claude -p --session-id <id>`、B で `claude -p -r <id>` | 成立。合言葉を答え、作業ディレクトリは B（環境情報が B に更新された）。session の jsonl は A の `~/.claude/projects/<A>` に残り、そこに追記される（B の project ディレクトリには作られない） |
| Codex | A の `codex app-server` で `thread/start { cwd: A }`、B の別プロセスで `thread/resume { threadId, cwd: B }` | 成立。`thread/resume` の応答の `thread.cwd` が B になり、合言葉と B を答えた |

## 設計への影響

- 既存の会話を worktree に移すとき、両 Agent とも今の session を新しい作業ディレクトリで resume すれば会話を続けられる（session の移し替えは不要）。DESIGN.md §28 D1「既存の会話を worktree に移す」
