# Spike L — 書き込みだけを制限したトークンで Agent を動かす

## 目的

人の方針: 「project の外への書き込み・削除だけを物理的に止め、それ以外（読み取り、ネットワーク、プロセスの実行）はすべて許す」。

Spike K（専用ユーザー `clodex-agent`。`docs/specs/sandbox-user-spike.md`）には、次の問題があった:

- Windows のユーザーを増やす
- CLI の別途インストールとログインが要る
- 環境変数やコマンドラインの長さの上限が絡む
- `dubious ownership` になる
- システム以外のドライブに Deny を付けると、継承の反映でドライブ全体を走査するため非常に遅い

代わりに、人のユーザーのトークンから **write-restricted token**（`CreateRestrictedToken` の `WRITE_RESTRICTED`）を作り、それで Agent を起動する方式を実測する。結果は `docs/spikes/sandbox-token.md` に記録する。

## 仕組み

- write-restricted token は、読み取りの判定には人のユーザーの通常の権限を使う。書き込みの判定では、それに加えて restricting SID のどれかに書き込みが許されていることを要求する
- restricting SID には、Clodex 専用の SID を 1 つ使う。ACL に載せるための識別子で、ユーザーではない
- 書き込みを許す場所にだけ、その SID の Modify（継承あり）を付ける。付ける先は人が所有するディレクトリなので、管理者権限は要らない
- 同じユーザーなので、CLI・ログイン情報・PATH・`~/.claude` などの設定はそのまま使える
- 作成されるファイルの所有者も人のまま
- 既存の例: Codex の Windows sandbox が、この PC の `C:\Users\Horry` と `E:\dev\Clodex\spikes` に capability SID（`S-1-15-3-…`）や独自の SID の ACE を付けている。同じ系統の仕組みと思われるので、`icacls` で中身を確認して記録する

## 書き込みを許す場所（初期案。計測で増減する）

- project のディレクトリ
- `~/.clodex/artifacts/<project>`
- `~/.claude`、`~/.claude.json`、`~/.codex`（セッションと認証の更新）
- 一時ディレクトリ: `%TEMP%` 全体ではなく、Clodex 専用の一時ディレクトリを作り、`TEMP` / `TMP` をそこに向ける
- パッケージのキャッシュ（pnpm store、npm cache、Playwright のブラウザ）は、#4 の結果を見て決める

## 計測項目

| # | 項目 | 確かめること |
|---|---|---|
| 1 | 起動 | 人のユーザー（管理者でない）が、自分のトークンから write-restricted token を作り、stdin / stdout / stderr を pipe でつないだままプロセスを起動できるか（`CreateRestrictedToken` + `CreateProcessAsUser`。PowerShell の `Add-Type` による P/Invoke の helper でよい）。子プロセスにも制限が継承されるか |
| 2 | 書き込みの境界 | 書き込みを許した場所には作成・削除ができ、それ以外（`E:\` 直下、別の project、人のプロファイル直下、`%APPDATA%`）は拒否されること。ドライブの ACL は変更しない |
| 3 | 読み取り | 人のプロファイル、ほかの project、`C:\Program Files` を読めること |
| 4 | ツール | `node` / `pnpm install` / `git`（status・commit）/ `claude --version` / `codex --version` が動くか。失敗したら、どこへの書き込みで失敗したかを記録する（ACCESS_DENIED のパス） |
| 5 | レジストリ | HKCU への書き込みが拒否されるか。それで壊れるツールがあるか |
| 6 | ネットワーク | `git ls-remote`・`pnpm view`・HTTPS の取得ができること |
| 7 | 停止 | 人のユーザーから `taskkill /T /F` でプロセスツリーを止められること |
| 8 | 所有者 | 作ったファイルの所有者が人のユーザーで、人の `git status` / `git commit` で `dubious ownership` にならないこと |
| 9 | MCP | Hub が `127.0.0.1` で待ち受ける MCP に届くこと |
| 10 | 実 Agent（`--run-cli` のときだけ） | Claude `bypassPermissions`、Codex `danger-full-access` で 1 ターンずつ動かす。project 内には書けて、project 外への書き込みは OS に拒否されること。Playwright でスクリーンショットを撮れるか |
| 11 | ACL を付ける時間 | project のディレクトリに SID の ACE を付けるときにかかる時間（`E:\dev\Clodex` 程度の大きさで） |

## 進め方

- スクリプト: `spikes/sandbox-token.ts`（helper の P/Invoke を含む）。管理者権限は使わない
- ACL の付与と除去は spike の中で行い、終了時に除去する（`--keep` で残せる）
- 実 CLI を使う #10 は `--run-cli` を付けたときだけ実行する（利用枠を消費するため、人の了承の後）
- Spike K のスクリプト（`spikes/sandbox-user*`）は、結果を比べ終わるまで残す
