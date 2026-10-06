# Spike M — 専用ユーザー + write-restricted token

## 背景

- Spike K（専用ユーザー `clodex-agent`。`docs/specs/sandbox-user-spike.md`）: 境界は強い。ただし `E:` などのドライブは `Authenticated Users` に Modify が付いているため、ドライブのルートに Deny を付ける必要があり、ドライブ全体の走査で非常に遅い
- Spike L（人のユーザーの write-restricted token。`docs/spikes/sandbox-token.md`）: ツールはよく動く。ただし人の SID が Full Control を持つ場所（home・`APPDATA`）で削除が通る。一方、`Authenticated Users` 経由でしか許可がない `E:\` と `E:\dev\Clodex` では、書き込みも削除も拒否された
- 通常の restricted token は、HKCU や子プロセスの起動が壊れるので採らない

## 仮説

`clodex-agent` の中で、自分のトークンから write-restricted token を作り、restricting SID を {`clodex-agent` の SID, logon SID, `Everyone`, `BUILTIN\Users`} にして Agent を起動する。`Authenticated Users` は入れない。こうすると:

- `E:` などの `Authenticated Users` の Modify が効かなくなる。ドライブに Deny を付けなくても、project 外へは書けず、削除もできない
- 人の home はもともと `clodex-agent` から見えないので、Spike L の削除の穴は起きない
- 削除が通るのは `clodex-agent` 自身のプロファイルと、明示的に許可した project・artifacts だけ
- HKCU は `clodex-agent` のものなので、Spike L の通常版のような HKCU の失敗は起きない

これは Codex の Windows sandbox（`CodexSandboxOffline` / `CodexSandboxOnline` のユーザー + `WRITE_RESTRICTED`）と同じ系統の構成。

## 計測項目

Spike K の setup（`spikes/sandbox-user-setup.ps1`）でできた `clodex-agent` を使う。ドライブの Deny は使わない。

1. 前提の確認: `D:\`・`E:\` のルートと `E:\dev\Clodex` に、`clodex-agent` の Deny が残っていないこと（state の `deniedDrives` に `D:\`・`E:\` が記録されているが、`E:\` のルートには ACE が無い。中断された可能性がある）。残っていれば、計測の結果に影響する場所を記録し、人に知らせる
2. 起動: broker（`clodex-agent` として動いている）が、自分のトークンから write-restricted token を作り、Agent を起動できるか。stdio、子・孫への継承
3. 書き込み・削除の境界（Win32 の `CreateFileW` / `DeleteFileW` で確認。Node の `unlinkSync` の結果だけで判定しない）: 許可した project、`clodex-agent` のプロファイル、`E:\` 直下、`E:\dev\Clodex`、`D:\` 直下、`C:\Users\Public`、`C:\ProgramData`、`C:\Windows\Temp`
4. ツール: Spike L と同じ（`node` の子プロセスの起動を含む、`pnpm install`、git、`claude` / `codex` の版、PowerShell 5.1 / 7 の起動）
5. ネットワーク・MCP・停止: Spike L と同じ
6. 書き込みの許可に要る ACL: project と artifacts だけで済むか。済まない場合は、追加で要った場所

結果は `docs/spikes/sandbox-hybrid.md` に、Spike K・L と比べられる表で記録する。実 CLI のターンは実行しない。
