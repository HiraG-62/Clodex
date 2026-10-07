# Spike N — Authenticated Users の deny-only

製品と同じ broker / helper のプロセス・スレッド DACL のまま、`CreateRestrictedToken` の `SidsToDisable` に `S-1-5-11` のみ渡す。`SidsToRestrict` は空、flags は0。製品コードは変更しない。

2026-10-07、同じ run で書き込み・Win32削除、脱出ハンドル、認証・HTTPS、ツールと MCP を計測した。実 CLI のターン・管理者操作・ログインは実行していない。

## 結果

AU の attributes=16（deny-only）、restrictingSids=[]、IsTokenRestricted=false。agent SID は末尾1006。Everyone・Users・Interactive は attributes=7 のまま。broker / helper / bootstrap の DACL と default DACL は製品と同じで、診断用 helper のトークン作成部分だけを置き換えた。

| 項目 | 通常の restricted token（既存実測） | N: AU deny-only |
|---|---|---|
| Codex account/read | -32603 / workspace routing discovery failed | accountType=chatgpt |
| PowerShell 5.1 HTTPS | SEC_E_NO_CREDENTIALS 相当 | HTTP 200 |
| Claude auth status | loggedIn=true / authMethod=claude.ai | 同左、exit 0 |
| Node HTTPS | HTTP 200 | HTTP 200 |
| broker / helper / bootstrap の危険なハンドル取得 | 拒否 | 拒否 |
| PowerShell 5.1 / 7 | 起動成功 | 5.1.26100.9444 / 7.6.6、成功 |
| Node 子プロセス / HKCU 読み書き | 成功 | 成功 |
| pnpm install（copy） | 成功 | 成功 |
| pnpm hard link | 拒否 | install --force --package-import-method=hardlink 成功。store ファイルの fs.linkSync も成功 |
| git init / 空 commit | 成功 | 成功 |
| MCP initialize | 成功 | protocolVersion=2025-03-26 |
| E: / Program Files / agent プロファイル読取り | 成功 | 成功 |
| 人のプロファイルの列挙 | 拒否 | EPERM |

restricted 側は `docs/spikes/sandbox-product.md` と `docs/spikes/sandbox-schannel.md` の既存実測であり、同時再測定ではない。N 側の全項目は1つの broker 接続で測定。Claude 2.1.292、Codex 0.160.1、pnpm 12.9.1。pnpm の製品環境変数は copy のまま、hard link 試験だけ引数で上書きした。

## Win32 境界

新規作成は CreateFileW(GENERIC_WRITE, CREATE_NEW)。既存ファイルは CreateFileW(DELETE, OPEN_EXISTING) と DeleteFileW を別々に試した。すべてランダム名の検証ファイルで、人の既存ファイルは対象外。error 5 はアクセス拒否。

| 場所 | N: 新規作成 / 自分の作成物の削除 | N: 既存 fixture の DELETE open / DeleteFileW | M の既存実測 |
|---|---|---|---|
| 許可 project | 成功 / 成功 | 成功 / 成功 | 同左 |
| 許可 artifacts | 成功 / 成功 | 成功 / 成功 | 同左 |
| agent プロファイル | 成功 / 成功 | 成功 / 成功 | 同左 |
| E: 直下 | 5 / 対象なし | 5 / 5 | 同左 |
| E:\dev\Clodex | 5 / 対象なし | 5 / 5 | 同左 |
| D: 直下 | 5 / 対象なし | 5 / 5 | M は残存 Deny あり。今回のルートに Deny なし |
| C:\Users\Public | **成功 / 成功** | **成功 / 成功** | 作成・削除拒否 |
| C:\ProgramData | 成功 / 成功 | 5 / 5 | 同左 |
| C:\Windows\Temp | 成功 / 成功 | 5 / 5 | 同左 |
| 人の home | 5 / 対象なし | 5 / 5 | 同左 |

既存 fixture は agent プロファイル内だけ agent 作成、ほかは人が作成。E: / D: のルート ACL を読み取り、AU Modify と Users RX を確認した。どちらも今回のルートに Deny はない。配下全体の再帰監査は行っていない。

Public の DACL は Interactive / Batch / Service に作成権限と継承 Modify を許可していた。今回の agent は Interactive（S-1-5-4）が enabled なので、AU を無効にしてもこの許可が残る。通常の restricted token では Interactive が restricting SID に含まれず、二重のアクセス判定で拒否されていたと解釈できる。

## 脱出試験の範囲

helper → broker → bootstrap の3プロセスに対し、OpenProcess の ALL_ACCESS / QUERY_INFORMATION / QUERY_LIMITED_INFORMATION / DUP_HANDLE / VM_WRITE / CREATE_THREAD はすべて error 5。列挙できた全スレッドの OpenThread SET_CONTEXT / IMPERSONATE / DIRECT_IMPERSONATION もすべて error 5。

OpenProcessToken / DuplicateTokenEx は前提のプロセスハンドルを取得できず未到達。NtImpersonateThread も source thread ハンドルを取得できず未到達。これら API 自体が拒否を返したという記録ではなく、前提のハンドル取得が遮断された結果。Agent 自身の Node 子プロセスは正常に起動した。

## Everyone / Users の追加無効化について

Users を deny-only にすれば、ProgramData の Users に対する新規作成許可は使えなくなる見込み。ただし E: の読み取りも Users RX に依存しており、そのまま無効にする案は今回の「読めるが書けない」を満たさない。Everyone の無効化だけでは ProgramData の Users ACE を止められない。Public の Interactive ACE は、どちらの無効化でも残る。

Windows Temp は人の非管理者プロセスから DACL を読めず、許可元の SID は未特定。Everyone / Users の追加無効化は未実験で、製品への採否も未決定。まず **AU deny-only により Public の既存ファイル削除まで許される差分**を含めて許可範囲を決める必要がある。

## 成果物・後片付け

- 再現: `pnpm exec tsx spikes/sandbox-deny-only.ts`。
- 最終ログ: `C:\Users\Horry\.clodex\sandbox-deny-only-e4cb34d8-faff-4683-bd6b-ac0c9050e33f.json`。アカウント識別情報や資格情報は記録していない。
- 計測 project: `E:\dev\clodex-deny-only-69cd04ec-0d13-4a20-b4ee-06edafde52d2`。既存 project の lease に干渉しないよう新規作成した。
- project / artifacts の追加 agent ACE は解除済み。runtime の診断用ディレクトリ、境界検証ファイル、HKCU の検証キーは除去済み。project 内の計測用プログラム・package・一時 git repo は保持。
- 製品コード変更・Clodex リポジトリのコミットなし。git commit は計測用 repo だけで実行。
- 検証: `pnpm test` 764 passed / 5 skipped、`pnpm typecheck`、spike 自体の strict 型チェック、`git diff --check` 成功。

## AU + INTERACTIVE の追加計測と製品化

2026-10-07。`--interactive` で AU と INTERACTIVE の2 SID を deny-only にした。同じ run で全項目を再計測し、両 SID の attributes=16、restrictingSids=[] を確認した。

| 項目 | AU のみ | AU + INTERACTIVE |
|---|---|---|
| Public 新規作成 / 既存 fixture の DELETE open / DeleteFileW | すべて成功 | すべて error 5 |
| E: / D: / 別 project / 人の home | 作成・削除拒否 | 同左 |
| 許可 project / artifacts / agent home | 作成・削除成功 | 同左 |
| ProgramData / Windows Temp | 新規作成成功・既存削除拒否 | 同左 |
| broker / helper / bootstrap のプロセス・スレッド取得 | 全指定権限で拒否 | 同左。token複製・NtImpersonateThread は前提ハンドル拒否で未到達 |
| Codex account/read / Claude auth status | chatgpt / claude.ai | 同左 |
| PS5.1 HTTPS / Node HTTPS | 200 / 200 | 同左 |
| PS5.1 / PS7 / Node 子プロセス / HKCU | 成功 | 同左 |
| pnpm hardlink install / fs.linkSync / git commit / MCP | 成功 | 同左 |

ログは `C:\Users\Horry\.clodex\sandbox-deny-only-c521025b-a018-42be-8cd8-d81028818439.json`。製品もこの2 SID の deny-only を採用し、restricting SID は使わない。pnpm の copy 強制を外し、認証判定の条件は維持する。

製品 helper の配列マーシャリングへ変更後も全項目を再計測し、結果は同じだった。ログは `C:\Users\Horry\.clodex\sandbox-deny-only-51a29e71-9e0d-4779-a77b-28c80baa5143.json`。pnpm の copy 環境変数なしで install 成功、明示 hardlink と fs.linkSync も成功。CLI のパイプ経由のコンソール入出力・起動を確認し、対話 GUI やログインウィンドウは実行していない。

`spikes/sandbox-auth-probe.ts` は `authentication={claude:true,codex:true}`、`authenticate=true`、`setupStatus.authenticated=true`。`authentication.ts` の変更なし。`pnpm test` 766 passed / 5 skipped、`pnpm typecheck` と spike strict 型チェック成功。

DESIGN.md の変更案: 「専用ユーザー + AU / INTERACTIVE の deny-only、restricting SID なし」に置換する。broker 等の AU Allow は agent の deny-only グループでは利用できない。pnpm copy 固定・Schannel HTTPS 不可・AU のみの許可先は読み取り不可という旧制約は削除し、「AU / INTERACTIVE だけが読み取りを許す場所は読めない」「Users 等が作成を許す ProgramData / Windows Temp は引き続き作成可能」を記載する。過去の Schannel 比較スクリプトは通常の restricted token 版を前提とするため、現在の製品 helper で誤計測しないガードを追加した。
