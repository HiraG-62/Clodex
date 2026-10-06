# Spike M — 専用ユーザー + write-restricted token

2026-10-07。専用ユーザー内で WRITE_RESTRICTED を作る方式は起動でき、Deny のない E: 直下・別 project の Win32 作成・削除を拒否した。HKCU・ツール・ネットワークも動いた。ただし ProgramData / Windows Temp には新規作成できるため、「project 外には一切書けない」という境界ではない。

残存 Deny を確認後、新規 project `E:\dev\clodex-hybrid-test` を使用した。agent の Modify を人のユーザーで一時付与し、終了時に解除済み。D: は残存 Deny の影響ありと区別し、E: を主な判定対象にした。管理者操作と実 CLI のターンは未実行。

## #1 前提監査

agent SID: `S-1-5-21-2572754211-3031698276-2667316043-1005`。

| 対象 | agent の ACE |
|---|---|
| `D:\` | 明示 Deny、継承あり、rights=65878 |
| `E:\` | なし |
| `E:\dev` | なし |
| `E:\dev\Clodex` | なし |
| `E:\dev\Clodex\spikes` | なし |
| `E:\dev\clodex-sandbox-test` | 明示 Allow（Modify、rights=1245631）と継承扱いの Deny（rights=65878） |
| `C:\Users\Horry\.clodex\artifacts\sandbox-test` | 明示 Allow（Modify、rights=1245631） |

state の `complete=false`、`deniedDrives=[D:\, E:\]`。E: のルートに ACE がないことだけでは、配下に残存 Deny がないとは判定できない。今回は計測対象とその親を監査し、全ドライブの再帰走査は行っていない。

D: と旧 project は Deny の影響があるため、そのまま測っても「Deny なしで保護できた」という証拠にはならない。旧 project は使わず、新規 project に既存の agent ACE がないことを確認してから計測した。state の complete=false は今回の計測で書き換えていない。

## K・L との比較

| 項目 | K: 専用ユーザー（spec の既知結果） | L: 人の WRITE_RESTRICTED | M: 専用ユーザー + WRITE_RESTRICTED |
|---|---|---|---|
| E: の保護 | Authenticated Users の Modify 対策に Deny を追加 | E: / 別 project で作成・Win32 削除拒否 | Deny なしで作成・Win32 削除拒否 |
| 人の home | 別ユーザーのアクセス権で制限 | Win32 削除が通る | 作成・Win32 削除拒否 |
| agent 自身の home | 専用ユーザーの権限 | 対象外 | 作成・Win32 削除成功 |
| HKCU・ツール | 別ユーザー環境の調整が必要 | ツール起動可能、HKCU 書き込み拒否 | HKCU 読み書き・ツール起動成功 |
| 広く書き込みを許された場所 | 個別 ACL に依存 | Everyone Modify fixture に作成・削除成功 | ProgramData / Windows Temp に新規作成・自分の作成物の削除成功 |
| 人からの停止 | 別ユーザーなので制約あり | taskkill 成功 | 人の taskkill は拒否。broker の停止は成功 |

## #2 起動と継承

人から `Start-Process -Credential` で起動した localhost broker が `clodex-agent` として helper を実行し、helper が自身のトークンから WRITE_RESTRICTED を作った。default DACL は Spike L と同じく、起動ユーザー・restricting SID・SYSTEM の GENERIC_ALL。agent SID と起動ユーザーは同一。

broker 自体は restricted=false、子・孫では restricted=true。stdio の `stdin-ok` / `stderr-ok` と、Node → Node → native helper の起動成功を確認した。restricting SID は以下で、Authenticated Users と人の SID は含まれていない。

- agent: `S-1-5-21-2572754211-3031698276-2667316043-1005`
- logon: `S-1-5-5-0-325382`
- Everyone: `S-1-1-0`
- BUILTIN\Users: `S-1-5-32-545`

## #3 Win32 の書き込み・削除境界

新規作成は `CreateFileW(GENERIC_WRITE, CREATE_NEW)`。既存の検証用ファイルに対する `CreateFileW(DELETE)` と `DeleteFileW` も別に実行した。error 5 は ACCESS_DENIED。利用者の既存ファイルは変更していない。

| 場所 | 新規作成 / その作成物の削除 | 既存検証ファイルの DELETE open / DeleteFileW | 既存検証ファイルの作成者 |
|---|---|---|---|
| `E:\dev\clodex-hybrid-test` | 成功 / 成功 | 成功 / 成功 | 人 |
| `C:\Users\Horry\.clodex\artifacts\sandbox-test` | 成功 / 成功 | 成功 / 成功 | 人 |
| `C:\Users\clodex-agent` | 成功 / 成功 | 成功 / 成功 | agent |
| `E:\` | error 5 / 対象なし | error 5 / error 5 | 人 |
| `E:\dev\Clodex` | error 5 / 対象なし | error 5 / error 5 | 人 |
| `D:\` | error 5 / 対象なし | error 5 / error 5 | 人。残存 Deny の影響あり |
| `C:\Users\Public` | error 5 / 対象なし | error 5 / error 5 | 人 |
| `C:\ProgramData` | **成功 / 成功** | error 5 / error 5 | 人 |
| `C:\Windows\Temp` | **成功 / 成功** | error 5 / error 5 | 人 |
| `C:\Users\Horry` | error 5 / 対象なし | error 5 / error 5 | 人 |

ProgramData は BUILTIN\Users に `(CI)(WD,AD,WEA,WA)` がある。Users を restricting SID に含める構成では、この許可先への新規作成が通る。Windows Temp の ACL 読取りは人の非管理者ユーザーでも拒否され、許可元の ACE は未特定。どちらも人が作った検証ファイルの削除は拒否されたが、ディレクトリ全体への書き込みを防ぐ境界ではない。

## #4〜#6 ツール・通信・停止・ACL

| 項目 | 結果 |
|---|---|
| node / pnpm / git | `22.13.1` / `12.9.1` / `2.45.1.windows.1`、version 成功 |
| claude / codex | `2.1.291` / `0.160.1`、version のみ成功。ターンは未実行 |
| PowerShell | 5.1 と 7.6.6 の起動成功 |
| Node 子・孫 | 起動成功、最下層で同じ restricting SID を確認 |
| pnpm install | `is-number@7.0.0`、`--ignore-scripts` で成功。store は新規 project 内 |
| git | agent 所有の一時 repo で init / status / 空 commit 成功。署名・hooks は無効化 |
| HKCU | agent の `Software` 読取りとランダムなキー作成に成功。キーは除去済み |
| ネットワーク | git ls-remote / pnpm view / Node HTTPS（200）成功 |
| MCP | localhost の SDK server に initialize 成功（protocolVersion `2025-03-26`） |
| 人の taskkill | exit 128、アクセス拒否。計測対象の親・子は残存 |
| broker 経由の停止 | 同じ agent ユーザーから kill。親・子の消滅を確認 |
| 追加 ACL | **新規 project の agent Modify だけ**。artifacts は setup の既存 Modify を使用 |

追加の cache・CLI 配置先・HKCU・共有 window station / desktop の ACL は変更していない。これで実 CLI の認証や実際のツール呼び出しまで保証したわけではない。

host 側 PowerShell 5.1 が親の PowerShell 7 用 PSModulePath を継承して token ファイルの ACL 設定に失敗したため、既存 broker の host 起動時に PSModulePath を Windows PowerShell 用へ設定した。Node の計測コードは `.cjs` ファイルに置き、PowerShell 5.1 の native 引数で引用符が落ちる影響を避けた。

## 成果物と記録

- 入口・監査・Win32 helper: `E:\dev\Clodex\spikes\sandbox-hybrid.ts`。
- 計測処理: `E:\dev\Clodex\spikes\sandbox-hybrid-runner.ts`。
- テスト: `E:\dev\Clodex\spikes\sandbox-hybrid.test.ts`、3 件。
- 最終生ログ: `C:\Users\Horry\.clodex\sandbox-hybrid-92e21ce1-e69b-4348-9061-0178973f3f62.json`。
- 最終前提監査: `C:\Users\Horry\.clodex\sandbox-hybrid-audit-64ccbaa4-c9c2-4614-b959-50d3cd2c82c3.json`。

```powershell
pnpm exec tsx spikes/sandbox-hybrid.ts --audit-only
pnpm exec tsx spikes/sandbox-hybrid.ts
# 中断時の新規 project の追加 ACE 解除
pnpm exec tsx spikes/sandbox-hybrid.ts --cleanup
```

最終 run の project ルートは前後 SDDL 一致。ルートと helper.exe で agent ACE が 0 件、broker token ファイルの残存もないことを確認した。初回の新規 project 更新時は SDDL に AI（自動継承済み）が加わったが、追加 ACE は解除済み。計測用 repo・helper・package は project 内に保持している。

`pnpm test` 700 passed / 5 skipped、`pnpm typecheck`、spike 個別 strict 型チェック成功。

## 残存 Deny の除去手順（人が管理者で実行、未実行）

**D: と E: の既存 Deny はこの計測では除去していない。** 計測終了後、人が同じ Horry ユーザーで PowerShell を管理者として開いて実行する。ドライブ全体の継承再計算に時間がかかるため、完了まで中断しない。

`-Uninstall` は agent ユーザー・資格情報・project の Allow まで削除するため、Deny だけの除去には使用しない。次は D: / E: のルートで agent の明示 Deny だけを削除し、E: にルート ACE がない場合も現行 DACL を再適用して子の継承を再計算する。所有者・Allow・他ユーザーの ACE は維持する。

```powershell
$spikeState = Get-Content "$env:USERPROFILE\.clodex\sandbox-user-state.json" -Raw | ConvertFrom-Json
$spikeSid = [Security.Principal.SecurityIdentifier]::new($spikeState.agentSid)
$spikeAccess = [Security.AccessControl.AccessControlSections]::Access
$spikeBefore = foreach ($spikeRoot in @('D:\', 'E:\')) {
    $spikeAcl = [IO.Directory]::GetAccessControl($spikeRoot, $spikeAccess)
    [pscustomobject]@{ path = $spikeRoot; sddl = $spikeAcl.GetSecurityDescriptorSddlForm($spikeAccess) }
}
$spikeBefore | ConvertTo-Json | Set-Content "$env:USERPROFILE\.clodex\drive-deny-before.json" -Encoding UTF8
foreach ($spikeRoot in @('D:\', 'E:\')) {
    $spikeAcl = [IO.Directory]::GetAccessControl($spikeRoot, $spikeAccess)
    foreach ($spikeRule in $spikeAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
        if ($spikeRule.IdentityReference -eq $spikeSid -and $spikeRule.AccessControlType -eq 'Deny') {
            [void]$spikeAcl.RemoveAccessRuleSpecific($spikeRule)
        }
    }
    $spikeAcl.SetSecurityDescriptorSddlForm($spikeAcl.GetSecurityDescriptorSddlForm($spikeAccess), $spikeAccess)
    [IO.Directory]::SetAccessControl($spikeRoot, $spikeAcl)
}
```

通常の非管理者ターミナルに戻り `pnpm exec tsx spikes/sandbox-hybrid.ts --audit-only` を実行し、D: と旧 project の Deny が消えたことを確認する。継承保護された子やアクセス不能な場所まで解除できたことは、この監査だけでは保証しない。残存があれば場所を記録して個別確認する。state の deniedDrives / complete はこの手順で変更しない。

継承あり DACL の再適用が子へ伝播する根拠: [SetNamedSecurityInfoW](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow)。
