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

## 通常の restricted token との比較（追加計測）

`--full-restricted` は CreateRestrictedToken の flags=0、restricting SID は synthetic / logon / Everyone / BUILTIN\Users。人の SID と Authenticated Users は含めない。default DACL は従来と同じ。

CLI 配置先には継承あり RX、home / AppData / Roaming / Local には継承なしの Traverse・ReadAttributes・ReadExtendedAttributes のみを付ける。Modify の許可先は従来と同じ。読み取りも制限される副作用と、home・APPDATA で削除が通った仮説を比較する。#11 は再計測しない。

### 比較結果

| # | 項目 | WRITE_RESTRICTED 版 | 通常 restricted token |
|---|---|---|---|
| 2 | project・専用 TEMP・artifacts・`.claude`・`.codex` | 作成・削除成功 | 作成・既存ファイル読取り・上書き・削除成功 |
| 2 | `E:\` / `E:\dev\Clodex` | 作成・上書き・削除拒否 | 同じ。既存の検証用ファイルは読める |
| 2 | home 直下 / APPDATA 直下 | 作成・上書き拒否、Win32 削除成功 | 作成・上書き・Win32 削除・既存ファイル読取りすべて拒否 |
| 2 | `C:\Users\Public` | 作成・上書き・Win32 削除拒否、既存の検証用ファイル読取り成功 | 作成・上書き・Win32 削除・読取り拒否 |
| 2 | project 外の Everyone Modify fixture | 作成・削除成功 | 作成・削除成功。境界漏れは残る |
| 3 | home / Documents / APPDATA の列挙 | home 列挙成功。Documents・APPDATA の列挙は旧試験対象外 | すべて EPERM |
| 3 | 別 project / Program Files の列挙 | 成功 | 成功 |
| 4 | node / pnpm / git / claude / codex の version | 成功 | helper から直接起動すればすべて成功 |
| 4 | pnpm install / git status・commit | 成功 | 成功。ただし git status は `.config/git/ignore` の Permission denied を警告 |
| 4 | PowerShell / Node の子プロセス | PowerShell と孫プロセスが起動 | PowerShell 起動失敗、Node spawnSync は EPERM |
| 5 | HKCU | 書き込み拒否 | `RegOpenKeyEx(HKCU\Software, KEY_QUERY_VALUE)` と `RegCreateKeyEx` がともに Win32 error 5 |
| 6 | git ls-remote / Node HTTPS | 成功 | 成功、HTTP 200 |
| 6 | pnpm view | 既定 cache は EPERM、project 内 cache で成功 | 同じ。既定 cache は `_cacache\tmp` の mkdir が EPERM |

Public はこの PC では Everyone の書き込み許可先ではない。`icacls C:\Users\Public` は INTERACTIVE / SERVICE / BATCH の書き込み ACE を表示した。実在の Public と、Everyone Modify を明示した project 外の新規 fixture を区別して計測した。

通常版の pnpm は `C:\Users\Horry\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs` を Node から直接起動した。PowerShell wrapper の成功を示す結果ではない。git commit は一時 repo で user.name / user.email を指定し、hooks・署名を無効化した。人の git 設定全体が使えるという結果でもない。

### 削除仮説の対照試験

restricting SID を `{synthetic, logon, Everyone, BUILTIN\Users}`、ACL・default DACL・呼び出す Win32 API を同一にし、flags だけを `0` / `WRITE_RESTRICTED` に変えた。人が作成した計測ファイルに対し、`CreateFileW(DELETE)` でハンドル取得後に閉じ、`DeleteFileW` を実行した。

| 対象 | flags=WRITE_RESTRICTED: DELETE open / DeleteFileW | flags=0: DELETE open / DeleteFileW |
|---|---|---|
| `C:\Users\Horry` | 成功 / 成功 | error 5 / error 5 |
| `C:\Users\Horry\AppData\Roaming` | 成功 / 成功 | error 5 / error 5 |
| `E:\` | error 5 / error 5 | error 5 / error 5 |
| `C:\Users\Public` | error 5 / error 5 | error 5 / error 5 |

この差は WRITE_RESTRICTED が削除経路に影響する仮説を支持し、前回の #2 の結果を説明できる。ただし `DELETE` と親の `FILE_DELETE_CHILD` のどちらの照合が省略されたかは、今回の試験では分離していない。Windows 内部の照合対象をすべて確定したとは扱わない。[通常 restricted token の二重照合仕様](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)とも整合する。

Node の `unlinkSync` は WRITE_RESTRICTED でも home / APPDATA で EPERM になった。API による差があるため、Node の拒否だけで削除境界が成立したとは判定しない。

### 互換性と ACL 更新

- PowerShell 5.1 は起動失敗。別途 PowerShell 7 を同じ構成で起動すると `Requested registry access is not allowed`、GPO 設定の読取り中に SecurityException。レジストリ読取りの制限が shell の起動を阻害している。
- Node 自体は動くが、Node から同じ node.exe を spawnSync すると EPERM。直接起動の成功を Agent のツール実行成功とは扱えない。子の起動失敗の原因は未特定。
- 旧 Get-Acl / Set-Acl は home で SeSecurityPrivilege を要求したため、DACL だけを取得・更新する実装にした。
- .NET の SetAccessControl は継承なしの ACE でも home 以下を走査し、90 秒でタイムアウト。継承なしの更新・除去には SetFileSecurityW を使用し、対象だけを変更する。Modify / RX の継承あり ACE は従来どおり伝播する。[SetFileSecurityW の仕様](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/securitybaseapi/nf-securitybaseapi-setfilesecurityw.md)。
- 走査 ACE は Traverse / ReadAttributes / ReadExtendedAttributes（.NET が Synchronize を付加）、継承なし。home の内容一覧やファイル読取りは許可しない。

通常 token は指定した home / APPDATA の削除を止めたが、読み取り制限・shell 起動失敗・Node の子起動失敗・Everyone の書き込み先という課題が残る。現時点で「読み取りと実行はすべて許す」という方針を満たすものではない。

### 再現・後片付け

```powershell
pnpm exec tsx spikes/sandbox-token.ts --full-restricted --output C:\Users\Horry\.clodex\sandbox-token-full-report.md
```

最終 run: `2e38b90a-c90a-43a0-a014-d78ff9d5e6f4`。synthetic SID: `S-1-5-21-148747068-872581202-400558888-1574807873`。生ログは `C:\Users\Horry\.clodex\sandbox-token-full-report.md`、manifest は `C:\Users\Horry\.clodex\sandbox-token-2e38b90a-c90a-43a0-a014-d78ff9d5e6f4.json`。

全 12 付与先のルートで synthetic ACE 0 件。途中失敗を含む manifest はすべて cleaned=true、pending=0。Everyone fixture の追加 ACE も解除済み。管理者権限・共有 window station / desktop の DACL 変更・実 CLI のターンは使っていない。

追加検証: `pnpm test` 690 passed / 5 skipped、`pnpm typecheck` と spike 個別 strict 型チェック成功。`--full-restricted` と `--run-cli` の併用は拒否する。
