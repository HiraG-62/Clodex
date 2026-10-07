# sandbox の Schannel 調査

2026-10-07。製品コードは変更せず、`spikes/sandbox-schannel.ts` と `spikes/sandbox-schannel-native.cs` で同一 agent の比較を実施した。管理者操作・ログイン・CLI のターンは実行していない。

## 比較結果

同じプロファイル・環境変数・ログイン済み資格情報を使用。制限なしは broker から直接起動。restricted は製品の helper を使用し、restricting SID は agent・logon・Everyone・Users。Authenticated Users は追加していない。

| 構成 | Codex account/read | PowerShell 5.1 HTTPS | Windows curl HTTPS |
|---|---|---|---|
| broker 直接起動（制限なし） | account.type=chatgpt | HTTP 200 | HTTP 200 |
| 製品の restricted token | -32603 / workspace routing discovery failed | 受信時エラー、内部 Win32Exception は資格情報なし | exit 35 / SEC_E_NO_CREDENTIALS 0x8009030e |
| restricted token 自身の DACL に agent/logon/SYSTEM の GA を明示 | 同上 | 同上 | 同上 |
| 同じ helper、CreateRestrictedToken の restricting SID 数だけ0 | account.type=chatgpt | HTTP 200 | HTTP 200 |

最後の構成は IsTokenRestricted=false となり隔離を失うので採用不可。比較のためだけに使用した。接続先は `https://example.com`、Codex には initialize・initialized・account/read のみ送信した。応答のアカウント識別情報と資格情報は記録していない。

## OS API の比較

ネットワークへ接続しない C# probe でも SSPI の失敗が再現した。

| API | 制限なし | restricted |
|---|---|---|
| OpenProcessToken（自身、QUERY / DUPLICATE / READ_CONTROL） | 成功 | 成功 |
| LsaConnectUntrusted | 0 | 0 |
| LsaGetLogonSessionData（自身の AuthenticationId） | 0 | 0 |
| AcquireCredentialsHandle / Negotiate | 0 | 0x8009030e |
| AcquireCredentialsHandle / Schannel、auth dataなし | 0 | 0x8009030e |
| Schannel、SCHANNEL_CRED v4 / flags=0 | 0 | 0x8009030e |
| Schannel、MANUAL_CRED_VALIDATION + NO_DEFAULT_CREDS | 0 | 0x8009030e |
| NCryptOpenStorageProvider / Microsoft Software Key Storage Provider | 0 | 0 |
| NCryptCreatePersistedKey（名前なしの一時RSA鍵）・NCryptFinalizeKey | 0 | 0 |
| BCryptOpenAlgorithmProvider（RNG / SHA256 / AES / ECDH_P256） | 0 | 0 |

token 自身の DACL 変更でも上の結果は変わらない。CNG / KeyIso 全体へのアクセス不能、LSA 接続不能、自身の token を開けないことでは説明できない。ただし KeyIso のすべての操作を確認したわけではない。

## ACL と既知の報告

読み取り専用の ACL 調査では、`C:\ProgramData\Microsoft\Crypto` と `RSA` に Users / Everyone の RX、`Keys` に Everyone の Read があった。HKLM の `SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL` と `Control\Lsa` は Users の ReadKey がある。これらは AU にしか読み取りが許されていない対象ではない。ACL は変更していない。

[Codex #17459](https://github.com/openai/codex/issues/17459) に同様の restricted token / Schannel の失敗報告がある。[別実装の調査 #3207](https://github.com/deepseek-ai/deepseek-harness/discussions/3207) は当初レジストリ拒否を原因としたが、8月19日の追加実験で証明できず撤回している。外部報告だけを根拠に、この環境でも同じ内部判定だと断定はしない。

## SSPI のデバッガー追跡

`pnpm exec tsx spikes/sandbox-schannel.ts --debug --trace` で、restricted token 内の診断プロセスだけを CDB で追跡した。Microsoft の公開 PDB を使用し、LSASS には接続していない。OS は 10.0.26200.0、`sspicli.dll` は 10.0.26100.9278、PDB キーは `3EDD48FFBFD3AE1FDDE522AB7C3F659D1`。

`SSPICLI!SspipAcquireCredentialsHandle` の `IsOkayToExec` 呼び出し直後（+0xdf）は EAX=0。続く `NdrClientCall3` の直後（+0x274）は EAX=8009030e だった。Negotiate と Schannel の3構成すべて同じ結果になった。呼び出し元は `AcquireCredentialsHandleW → AcquireCredentialsHandleCommon → LsaAcquireCredentialsHandleW → SspipAcquireCredentialsHandle`。

これにより、ローカルの事前検査ではなく、SSPI / LSA の資格情報取得 RPC が失敗を返しているところまで確認できた。ただし RPC 内部のどのオブジェクトが拒否されたか、ACL 判定なのか restricted token 自体の制約なのかは未確認。`ACCESS_DENIED` を返す個別オブジェクトは捕捉できていない。

## 再現方法と判断

- `pnpm exec tsx spikes/sandbox-schannel.ts`: 上記4構成を順に比較する。CLI のターンは送らない。
- `--debug --trace`: 公開シンボルを取得して API 境界を追跡する。ブレークポイントは上記 DLL の命令位置に依存するため、別の PDB キーでは停止する。
- 診断用 runtime は人が所有する製品 runtime と同じ親ディレクトリに作り、終了時に除去する。デバッグ出力は git 管理外の `spikes/sandbox-schannel-debug.log` に保存する。

現時点で ACL を狭く追加すべき具体的な拒否対象は特定できていない。token 自身の DACL 修正では改善せず、restricting SID を維持した解決策は未成立。証拠のない Crypto / LSA の ACL 緩和は提案しない。追加調査は LSA 側の RPC 内部に絞る必要があり、製品構成は変更していない。
