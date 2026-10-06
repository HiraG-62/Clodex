# `/sandbox` 段階 1 の確認

2026-10-07、管理者権限なし。`spikes/sandbox-product.ts` を実行。実 CLI のターンは未実行。

| 項目 | 結果 |
|---|---|
| broker 経由の Agent SID | `clodex-agent`（末尾 `1005`） |
| restricted token | `true` |
| restricting SID | agent、logon、Everyone、BUILTIN\Users。Authenticated Users なし |
| Claude | `2.1.291 (Claude Code)` |
| Codex | `codex-cli 0.160.1` |
| `E:\dev\clodex-hybrid-test` の新規ファイル作成・削除 | 成功 |
| `E:\` 直下の新規ファイル作成 | `EPERM` |
| 追加した ACL・safe.directory の解除 | 成功 |

broker は `%ProgramData%\Clodex-Sandbox-<human SID>\<runtime ID>` に置く。親の DACL の継承を遮断し、人・SYSTEM・Administrators は Full Control、agent は RX。Node・native helper・bootstrap・環境設定を同じ場所に配置する。資格情報と接続 token は人の `.clodex` に置き、token ファイルの ACL は人だけに限定する。

環境の再構築では Machine の環境変数に加え、Windows の既知のフォルダーから `SystemRoot`・`ProgramFiles` 等を補う。`SystemRoot` が欠落すると Node の localhost 接続が `UNKNOWN` で失敗することを実測した。

起動用 PowerShell の標準出力を明示的にリダイレクトする。`Start-Process -Credential` の子が Hub 側の pipe を引き継ぐと、親 PowerShell の終了待ちと broker 接続待ちが競合する。停止時には接続を閉じた後、リダイレクトのファイルハンドルが閉じるまで短時間再試行して一時ファイルを除去する。

## 段階 2 の実装と検証範囲

ユーザー作成・UAC・CLI インストール・ログイン・uninstall は未実行。OS 操作を差し替えたテストと、PowerShell 5.1 の構文解析で検証した。

- パスワードは昇格前の人の PowerShell で生成し、人の DPAPI で `~/.clodex/agent-credential` に保存する。
- 平文の受け渡し先は `~/.clodex/sandbox-admin/password`。継承を切り、人の SID と Administrators だけに許可する。昇格側は読取直後に削除し、呼出元の finally と次回 on でも削除する。コマンドラインに平文は含めない。
- 昇格側は引数の `humanSid` を使い、DPAPI を扱わない。同じ人の昇格と、別の管理者アカウントによる昇格を想定する。
- `sandbox-account.json` はユーザー作成・Users グループ限定・サインイン画面からの非表示を記録し、`sandbox-setup.json` は認証確認の完了を記録する。中断後は存在と CLI の `--version` を再検査して再開する。
- Claude は[公式の Windows インストール手順](https://support.claude.com/en/articles/14554922-claude-code-user-faq)、Codex と pnpm は spec 指定の `npm install --global @openai/codex pnpm` を agent の環境で実行する。
- uninstall は全 project の記録を読み、追加した safe.directory と ACL を解除する。旧 spike の Deny は、記録したドライブ内の同じ SID・同じ権利の ACE だけを除去する。継承の保護状態と他の ACE は変えない。解除に失敗した場合はユーザーを削除せず、記録を残す。

## 人による確認手順

1. 計測用 project `E:\dev\clodex-hybrid-test` で `/sandbox`、`/sandbox on`。UAC と CLI のログインは PC の前で実施する。
2. ログイン用 PowerShell で `claude` のログインを完了して終了し、`codex login` を実行する。最後に PowerShell を閉じ、`/sandbox` が `on · セットアップ済み` になることを確認する。メッセージを送信する必要はない。
3. `/permission read-only` が拒否され、`/sandbox off` で以前の permission に戻ることを確認する。もう一度 on にして、ユーザー・CLI を再作成しないことを確認する。
4. セットアップ前の環境では UAC を一度キャンセルし、`Test-Path "$env:USERPROFILE\.clodex\sandbox-admin\password"` が false になること、次の on で再開できることを確認する。同一アカウントの昇格と別の管理者による昇格の両方を確認する。
5. `/sandbox uninstall`。旧 spike の `D:\` / `E:\` の走査は時間がかかる。完了後、専用ユーザー・資格情報・追加 ACL・追加 safe.directory の除去と、保存済み project の off を確認する。人が元から持つ safe.directory は残る。

実 CLI のターンを使う E2E は、この確認後に別途了承を得て実施する。
