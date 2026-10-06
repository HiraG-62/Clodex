# Spike K — Agent を専用の Windows ユーザーで動かす

## 目的

Agent（Claude / Codex）は常にフル権限（Claude `bypassPermissions`、Codex `danger-full-access`）で動かし、制限は Clodex の外側（OS のユーザー境界 + NTFS ACL）で行う。その前提となる挙動を実測し、`docs/spikes/sandbox-user.md` に記録する。設計（DESIGN.md への反映）は結果を見て claude が行う。

構成の想定:

- Hub はこれまでどおり人のユーザーで動く
- Agent のプロセスだけを権限の低いローカルユーザー `clodex-agent`（Users グループのみ）で起動する
- `clodex-agent` が書き込めるのは、許可した project のディレクトリ、自分のプロファイル、Clodex の artifacts の保存先だけ

## 製品としての要件（spike の後に DESIGN.md へ反映する）

- sandbox はコマンドで on / off を切り替える（例: `/sandbox on|off`）。既定は off（今までどおり、人のユーザーで動かす）
- 初めて on にしたときに、セットアップ（`clodex-agent` の作成、CLI へのログイン）を行う。2 回目以降の on はセットアップを省く
- on のときは Agent をフル権限に固定する。off のときは今の `/permission` の 3 段階を使う

spike のスクリプトもこれに合わせる:

- setup は冪等にする（2 回実行しても壊れない）。セットアップ済みかどうかを、管理者権限なしで判定できるようにする（`-Status` 等）。Clodex が on にするときの判定に使う

## 進め方（2 段階）

### 段階 1: スクリプトを書く（codex）

1. `spikes/sandbox-user-setup.ps1`（**人が管理者の PowerShell で実行する**。日本語を含めるなら UTF-8 BOM 付き）
   - `clodex-agent` を作る（ランダムなパスワード。Users のみ）
   - パスワードは人のユーザーの DPAPI（CurrentUser）で暗号化して `~/.clodex/agent-credential` に保存する
   - 引数で渡した project のディレクトリに `clodex-agent` の Modify を付ける（継承あり）
   - 元に戻す `-Uninstall`（ユーザーの削除、付けた ACL の除去）
   - システムドライブ以外の固定ドライブのルートに `clodex-agent` の Deny を付ける（下の「段階 2 の途中結果と追加の変更」）
2. `spikes/sandbox-user.ts`（人のユーザーで、管理者権限なしに実行する）。下の計測項目を順に実行し、表の形で結果を出力する
3. ここまでで RESULT を送る（実 CLI はまだ動かさない）

### 段階 2: 計測（人がセットアップと `clodex-agent` での CLI ログインを終えてから、claude が改めて依頼する）

## 計測項目

| # | 項目 | 確かめること |
|---|---|---|
| 1 | stdio を渡したままの起動 | 人のユーザーの Node から、stdin/stdout/stderr を pipe でつないだまま `clodex-agent` としてプロセスを起動できるか。候補を順に試し、動いたものと動かなかったもの（理由）を記録する: (a) `CreateProcessWithLogonW` + `STARTF_USESTDHANDLES` を呼ぶ小さな helper（PowerShell の `Add-Type` による P/Invoke でよい）、(b) 起動中ずっと `clodex-agent` として常駐する broker（scheduled task 等）が、localhost または named pipe 経由で Agent を起動して中継する方式 |
| 2 | 書き込みの境界 | `clodex-agent` から次の場所へのファイル作成・削除: 許可した project、別の project（`E:\dev` 直下の別ディレクトリ）、`E:\` 直下、人のユーザーのプロファイル、`C:\Windows\Temp`、`C:\ProgramData`。あわせて、各ドライブ直下の ACL（`icacls`）を記録する |
| 3 | 読み取りの境界 | 人のプロファイル（`~/.ssh`、`~/.claude`、`~/.codex`、`%APPDATA%`）を `clodex-agent` が読めるか |
| 4 | ツールの解決 | `clodex-agent` の PATH から `node` / `pnpm` / `git` / `claude` / `codex` が見つかるか。人のユーザーにだけ入れたもの（`%APPDATA%\npm` 等）が見えるか |
| 5 | 認証 | `clodex-agent` でログインした `claude` / `codex` が、サブスクリプションの認証で動くか（既存の startup-probe と同じ判定） |
| 6 | フル権限の動作 | `clodex-agent` 下で Claude `-p --permission-mode bypassPermissions`、Codex app-server `danger-full-access` が 1 ターン動き、project 内にファイルを書けること。project 外への書き込みは OS に拒否されること |
| 7 | MCP | `clodex-agent` の Agent から、人のユーザーの Hub が `127.0.0.1` で待ち受ける MCP に届くか |
| 8 | 停止 | 人のユーザー（管理者でない）から、`clodex-agent` のプロセスツリーを `taskkill /T /F` で止められるか。止められない場合、#1 の helper / broker 経由なら止められるか |
| 9 | 作成物の所有者 | `clodex-agent` が project に作ったファイルを、人のユーザーで編集・削除できるか。人のユーザーで `git status` / `git commit` が `dubious ownership` にならないか。`clodex-agent` で `git commit` できるか |
| 10 | artifacts | `~/.clodex/artifacts/<project>` だけに `clodex-agent` の書き込みを付けた場合、そこに書けて、`~/.clodex` のほか（`web-token` 等）は読めないこと |

## 段階 2 の途中結果（2026-10-07、実 CLI なし）と追加の変更

結果:

- #2: `E:\` と `E:\dev\Clodex` に `clodex-agent` が書き込めた。システムドライブ以外のドライブは、既定で `Authenticated Users` に Modify（継承あり）が付いているため。`C:\Windows\Temp`・`C:\ProgramData` にも書けるが、これは Windows の通常の挙動
- #4: 人のプロファイルの中にある CLI（`~/.local/bin/claude.exe`、`%LOCALAPPDATA%\Programs\OpenAI\Codex`、`%APPDATA%\npm\pnpm`）は、インストール先に RX を付けても使えない。Node は `realpath` で親フォルダを順に `lstat` するので、`C:\Users\<人>\AppData` で EPERM になる。人のプロファイルに穴を開けるより、CLI は `clodex-agent` 側に別途インストールする（`claude` の公式インストーラー、`npm i -g @openai/codex pnpm`）
- #1・#7・#8・#10 は期待どおり。#8 は人のユーザーから `taskkill /T /F` で止められた
- #9: `clodex-agent` が作ったリポジトリは、人のユーザーで `dubious ownership` になる
- `Start-Process -Credential` は、呼び出し元（人）の環境変数を引き継ぐ（`USERPROFILE`・`APPDATA` が人のもの）。そのため Claude のインストーラーとログインが `C:\Users\<人>\.claude` に書こうとして失敗した。製品で Agent を起動するときは、`clodex-agent` の環境（プロファイルのパス、Machine の PATH）を組み立て直して渡す

setup への追加:

- システムドライブ以外の固定ドライブ（`Get-Volume` 等で列挙）のルートに、`clodex-agent` の **Deny**（書き込み・削除。継承あり）を付ける。project には明示の Allow（Modify）が付いているので、継承された Deny より優先される。`-Uninstall` で外す。付けたドライブは state に記録する
- 継承の反映でドライブ全体を走査するため時間がかかる場合がある。開始時にその旨を表示する
- spike の #2 に、Deny の付いたドライブ上で「別の project」「ドライブのルート」には書けず、許可した project には書けることの確認を足す

## 記録

- `docs/spikes/sandbox-user.md` に上の表の結果、使った方法、CLI の版、日付を書く
- `docs/spikes/README.md` の表に Spike K の行を足す
- 実 CLI を使う #5・#6 はサブスクリプションの利用枠を消費するので、段階 2 で人の了承を取ってから行う
