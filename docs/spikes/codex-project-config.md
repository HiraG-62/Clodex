# Spike P — Codex の project doc とネットワーク

スクリプト: `spikes/codex-project-config.ts`（codex-cli 0.156.1、2026-10-08）

一時ディレクトリに `CLAUDE.md`（と `both` では `AGENTS.md`）を置き、`codex app-server` の `thread/start` を `sandbox: "workspace-write"` で始めて 1 ターン送った。

## 検証結果

### project doc

| 起動 | 置いたファイル | Codex が知っていた内容 |
|---|---|---|
| `-c` なし | `CLAUDE.md` | なし（`CLAUDE.md` は読まれない） |
| `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'` | `CLAUDE.md` | `CLAUDE.md` の内容 |
| 同上 | `AGENTS.md` と `CLAUDE.md` | `AGENTS.md` の内容だけ（`AGENTS.md` が優先） |

### ネットワーク（`workspace-write`）

| 設定 | `curl.exe`（Schannel） | Node の `fetch` |
|---|---|---|
| 既定 | `000`（失敗） | `EACCES` |
| `-c sandbox_workspace_write.network_access=true` | — | `200` |
| `turn/start` の `sandboxPolicy` に `networkAccess: true` | `SEC_E_NO_CREDENTIALS` | `200` |

- 既定の `workspace-write` ではネットワークに出られない。`pnpm install` などは失敗する
- `networkAccess: true` にしても、Schannel を使う TLS（`curl.exe`、PowerShell 5.1 の HTTPS）は失敗する。Codex の Windows sandbox が restricted token で動くため（[sandbox-schannel.md](sandbox-schannel.md) と同じ現象）。Node・pnpm・git（OpenSSL）は通る

## 結論

- `codex app-server` の起動引数に `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'` を付ければ、`CLAUDE.md` しかない project でも Codex が project のルールを読む。`AGENTS.md` があればそちらを使う
- `edit` でネットワークを許すには、起動引数の `-c sandbox_workspace_write.network_access=true`（thread の開始時）と、`sandboxPolicy` の `networkAccess: true`（`/permission` での切り替え時）の両方が要る
