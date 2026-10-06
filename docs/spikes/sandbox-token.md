# Spike L — write-restricted token

実施日: 2026-10-07。管理者権限なし。実 CLI のターンと Playwright（#10）は未実行。

**起動は成立したが、project 外の削除を止められず、現状は製品の境界要件を満たさない。**

## 起動条件

`CreateRestrictedToken(WRITE_RESTRICTED)` → `CreateProcessAsUser` で起動。通常の権限は無効化していない。専用ユーザー、ドライブ全体の ACL、window station / desktop の DACL は変更していない。

| 順序 | トークンの変更 | PowerShell 起動結果 |
|---|---|---|
| 1 | synthetic SID のみ。default DACL に人・synthetic SID・SYSTEM の GENERIC_ALL | `0xC0000142`、出力なし |
| 2 | 上記に logon SID を追加 | `0xFFFF0000`、CLR 初期化 `HRESULT 80070005` |
| 3 | 上記に Everyone (`S-1-1-0`) を追加 | 成功。以降はこの構成で計測 |

logon SID は対話セッションのオブジェクトへのアクセス、Everyone は残る起動失敗の切り分けのために追加した。既存オブジェクトの DACL 変更には進んでいない。default DACL は新しい制限付きトークンにだけ設定した。

最終 run: `d4fee607-ca30-4a70-9748-2de85fa9c28a`。restricting SIDs は次の 3 つで、孫プロセスでも同じだった。

- synthetic: `S-1-5-21-3629649507-4011311487-149303838-2214174081`
- logon: `S-1-5-5-0-325382`
- Everyone: `S-1-1-0`

## 計測結果

| # | 項目 | 結果 |
|---|---|---|
| 1 | 起動・継承 | stdin / stdout / stderr 接続成功。子・孫で restricted=true。孫から別 project への作成は拒否 |
| 2 | 書き込み・削除 | 下表。home・APPDATA の既存ファイル削除と Everyone 許可先に境界漏れ |
| 3 | 読み取り | 人の home、別 project、Program Files のディレクトリ列挙成功。全ファイル内容の読取りまでは未検証 |
| 4 | ツール | node、pnpm、git、claude、codex の version 成功。`pnpm install --ignore-scripts` と一時 repo の git status / commit 成功 |
| 5 | HKCU | ランダムな `HKCU\Software\ClodexTokenSpike-<run>` の作成を拒否。他のツールへの影響は網羅未検証 |
| 6 | ネットワーク | git ls-remote、Node fetch は成功（HTTP 200）。pnpm view は既定 cache で失敗、project 内 cache で成功。PowerShell 5.1 Invoke-WebRequest は受信エラー |
| 7 | 停止 | 人の `taskkill /T /F` 成功。対象の親・子 PID の消滅を確認 |
| 8 | 所有者 | 作成物は人の SID。人の git status / commit 成功。dubious ownership なし |
| 9 | MCP | `127.0.0.1` の SDK server に initialize 成功。protocolVersion `2025-03-26` |
| 10 | 実 Agent | 未実行。`--run-cli` で明示的に有効化する実装のみ |
| 11 | ACL 時間 | `E:\dev\Clodex` への付与 18,480 ms、除去 10,881 ms。ルートの前後 SDDL 一致 |

### #2 の境界

既存ファイルは人が計測専用に作成し、制限付きプロセスから上書き・削除を試した。既存の利用者ファイルは変更していない。

| 対象 | 新規作成 | 既存ファイル上書き | 既存ファイル削除 |
|---|---|---|---|
| `E:\dev\clodex-token-test` / 専用 TEMP / 専用 artifacts / `.claude` / `.codex` | 成功、作成物の削除も成功 | 未計測 | 未計測 |
| `C:\Users\Horry\.claude.json` | 対象外 | 書き込み用 open 成功、内容変更なし | 未計測 |
| `E:\` | 拒否 | 拒否 | 拒否 |
| `E:\dev\Clodex` | 拒否 | 拒否 | 拒否 |
| `C:\Users\Horry` | 拒否 | 拒否 | **成功** |
| `C:\Users\Horry\AppData\Roaming` | 拒否 | 拒否 | **成功** |
| project 外の新規 fixture、Everyone ACE なし | 拒否 | 未計測 | 未計測 |
| 同じ fixture に Everyone Modify を追加 | **成功**、作成物の削除も成功 | 未計測 | 未計測 |

fixture は `C:\Users\Horry\.clodex\everyone-fixture-d4fee607-ca30-4a70-9748-2de85fa9c28a`。Everyone ACE は終了時に解除済み。既存の Everyone 書き込み可能ディレクトリを網羅した調査ではない。

home / APPDATA で削除だけが通る原因は未特定。Everyone の追加がこの削除結果の原因とは断定していない。起動できた構成で観測した結果として扱う。

### #4・#6 の cache と互換性

Node `22.13.1` / pnpm `10.14.0` / git `2.45.1.windows.1` / Claude Code `2.1.291` / codex-cli `0.156.1`。

`pnpm install --ignore-scripts` は `is-number@7.0.0` の導入に成功した。大規模依存や install script、Playwright のブラウザ導入は未検証。

`pnpm view` は内部で npm を使い、`C:\Users\Horry\AppData\Local\npm-cache\_cacache\tmp\<id>` の open が EPERM、同 cache の `_logs` も書き込み拒否。`npm_config_cache=<run>\npm-cache` に変更すると `7.0.0` の取得に成功した。人の cache 全体への ACL は追加していない。

PowerShell 5.1 の HTTPS 受信エラーは原因未特定。Node fetch と git の HTTPS は成功しており、ネットワーク全体が遮断されている結果ではない。

## 既存の Codex 関連 ACE と参考実装

最終 run 前の `icacls` で確認した ACE（出所のすべてを逆追跡したものではない）:

- `C:\Users\Horry`: `S-1-15-3-65536-599108337-2355189375-1353122160-3480128286-3345335107-485756383-4087318168-230526575:(S,X)`。書き込み許可ではない。
- `E:\dev\Clodex\spikes`: `CodexSandboxUsers:(I)(OI)(CI)(M)` と `S-1-5-21-2296814686-1738220956-2523752052-3074478854:(I)(OI)(CI)(M)`。Authenticated Users の継承 Modify も存在。

[Codex の token.rs](https://github.com/openai/codex/blob/main/codex-rs/windows-sandbox-rs/src/token.rs)（2026-10-07 参照）では capabilities / extra restricting SIDs に logon SID・Everyone を加えている。フラグは `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`、default DACL も調整している。この spike は WRITE_RESTRICTED のみで、Codex と同等の sandbox ではない。インストール済みバイナリの内部トークン構成を直接検査した結果でもない。

API の仕様: [CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)、[TOKEN_DEFAULT_DACL](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_default_dacl)。

## 後片付けと再現

最終 run は全 6 対象のルートで、今回の synthetic SID の ACE が 0 件。manifest の pending は空、cleaned=true。計測ファイル・一時 repo・helper・manifest は保持している。

初回の起動失敗 run は #11 の前後 SDDL が不一致だった。比較元の文字列を保存していなかったため差分原因は不明。その run の SID が各付与先から除去済みであることは別途確認した。以降は前後の SDDL も記録し、最後の 3 回はルート SDDL 一致。全子孫の既存 ACL の完全復元までは検証していない。

- 実装: `E:\dev\Clodex\spikes\sandbox-token.ts`
- テスト: `E:\dev\Clodex\spikes\sandbox-token.test.ts`
- 最終生ログ: `C:\Users\Horry\.clodex\sandbox-token-final-report.md`
- 初期ログ: `C:\Users\Horry\.clodex\sandbox-token-initial-report.md`
- 最終 manifest: `C:\Users\Horry\.clodex\sandbox-token-d4fee607-ca30-4a70-9748-2de85fa9c28a.json`

```powershell
pnpm exec tsx spikes/sandbox-token.ts --output C:\Users\Horry\.clodex\sandbox-token-report.md
# --keep で残した synthetic ACE の解除
pnpm exec tsx spikes/sandbox-token.ts --cleanup <manifest>
```

`--run-cli` は付けない。制限付き helper は既に restricted な親と管理者トークンを拒否する。TEMP / TMP は書き込み許可先へ変更する。別途の補助試験で TEMP の変更を省くと PowerShell が ConstrainedLanguage になったため、その試験は ACL 判定結果から除外した。

検証: `pnpm test` 688 passed / 5 skipped、`pnpm typecheck` 成功。spike の TS は別途 strict な `tsc --ignoreConfig --noEmit` でも確認済み。
