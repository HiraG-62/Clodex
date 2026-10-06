# `/sandbox` の実装

`docs/DESIGN.md` §9「Sandbox」と Internal command の表を更新済み。実測の根拠は `docs/spikes/sandbox-hybrid.md`（Spike M）、`docs/spikes/sandbox-token.md`（L）、`docs/specs/sandbox-user-spike.md`（K）。spike のコード（`spikes/sandbox-*.ts`、`spikes/sandbox-user-setup.ps1`、`spikes/sandbox-agent-env.ps1`）は流用してよい。

2 段階で進め、段階ごとに RESULT を送る。

## 段階 1: sandbox の中で Agent を動かす

前提: `clodex-agent` は spike の setup で作成済み（`~/.clodex/sandbox-user-state.json`・`~/.clodex/agent-credential`）。agent 側の CLI のインストールとログインも済んでいる。段階 1 ではこの前提を検査するだけで、作成はしない。

- `src/sandbox/` を新設する
  - **状態の検査**: ユーザーの有無、資格情報の有無、agent 側の CLI の場所。管理者権限なしで判定する
  - **broker**: Hub が `clodex-agent` として起動する常駐プロセス
    - 起動は `Start-Process -Credential` 相当で、コマンドラインは 1024 文字に収める
    - broker のコードは、`clodex-agent` から読めて、書き換えられない場所に置く。人のプロファイルの中（`dist` や GUI の resource）は `clodex-agent` から読めない。置き場所は実装で決めて、DESIGN.md に足す案を RESULT に書く
    - Hub との接続は localhost と、ランダムな token で認証する。token は人のユーザーだけが読める場所に置き、broker には短い手段で渡す
    - broker は、Agent を write-restricted token（restricting SID は {agent, logon, `Everyone`, `Users`}）と、agent のプロファイルから組み立てた環境変数で起動する。stdio は中継し、停止（プロセスツリーごと）も行う
    - Hub の終了で broker も終わる
  - **`SpawnAgentProcess` の sandbox 版**: 既存の `AgentProcess` interface のまま broker 経由で動かす。Adapter と startup probe は差し替えるだけにする
  - **ACL**: project のディレクトリ（会話の worktree を含む）と `~/.clodex/artifacts/<project>` に、agent の Modify（継承あり）を付け外しする。spike と同じく、SDDL を前後で比べ、付けたものだけを外す
  - **git**: on のとき、人と agent の両方の git の global 設定に、project（と worktree）の `safe.directory` を足す。off のときは外す。agent 側は broker 経由で実行する
- `/sandbox`・`/sandbox on`・`/sandbox off`（`src/cli/commands.ts` ほか。i18n の文言は短く）
  - on / off は project ごとに `.settings.json` の `sandbox` に保存する。設定ファイルの `sandbox` も読む
  - 切り替えたら、両 Agent を止め、新しい session で起動し直す（会話の履歴は残す）
  - on の間は permission を `full` に固定し、`/permission` は拒否する。off で保存した permission に戻す
  - 前提を満たさない状態で on にしたら、段階 1 では「セットアップ未完了」とだけ返す
- テスト: 状態の判定、ACL の付け外しの対象、`safe.directory` の追加と削除、コマンドの解析、on / off での permission の固定と復帰、session の作り直し。OS に触れる部分は interface で差し替え、ユニットテストでは実際の ACL やユーザーを変えない
- 実機での確認（実 CLI のターンは使わない）: broker 経由で `claude --version` / `codex --version` が agent 側の CLI で動くこと。project 外への書き込みが拒否されること

## 段階 2: 初回のセットアップと uninstall

- `/sandbox on` の初回に、DESIGN.md の 1〜4 を行う
  1. UAC で昇格した PowerShell で、ユーザーの作成、サインイン画面に出さない設定（`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList`）、DPAPI の資格情報
  2. broker 経由で CLI をインストールする
  3. agent の PowerShell のウィンドウを開いてログインしてもらい、startup probe で確かめる
  4. 各段階は冪等にし、中断したら次の `/sandbox on` で続きから行う
- `/sandbox uninstall`: UAC で、ユーザー・資格情報・付けた ACL・`safe.directory` を消す。spike の state に残っている `deniedDrives` の Deny も、この時に外す（ドライブ全体の走査で時間がかかることを表示する）
- テストは段階 1 と同じ方針
- 実機での確認は人が行う（UAC とブラウザのログインがあるため）。手順を RESULT に書く

## 最後に

実 CLI で 1 ターン動かす確認（`CLODEX_E2E=1`）は、段階 2 の後に claude が人の了承を取ってから行う。codex は実行しない。

## 段階 1 のレビュー指摘（段階 2 の後に対応する）

DESIGN.md §9 Sandbox を更新済み（broker のプロセスの DACL、broker の置き場所、git の扱い）。

high:

1. **broker・helper の乗っ取り**: restricting SID に agent の SID があり、broker と helper のプロセスの DACL は agent の SID に GA を与えている。そのため、制限された Agent が `OpenProcess(PROCESS_VM_WRITE | PROCESS_CREATE_THREAD | PROCESS_DUP_HANDLE)` で、制限のない broker を乗っ取れる可能性がある。まず実測し、通るなら broker と helper の起動直後に、自分のプロセス（とスレッド）の DACL を絞る（`native-source.ts:94`、`windows-platform.ts:111`）。絞った後に通らないことも実測する
2. **git を経由した脱出**: DESIGN.md のとおり、人の git には `safe.directory` を足さない。`.git/config`・`.git/hooks`・`.git` の削除に agent の Deny を付け、off で外す。Hub の git 呼び出し（`src/project/file-preview.ts:79`、`project-files.ts:12`、`worktree.ts:24` ほか）に、無害化の `-c` と `--no-ext-diff --no-textconv` を付ける
3. **消えた worktree**: grant では存在しないパスを飛ばす。release では ENOENT の lease を消し、`safe.directory` の削除は続ける（`controller.ts:236`、`windows-platform.ts:210, 244`）

medium:

4. 起動時の `initialize` の失敗で project が開けなくなる（`project-context.ts:119`）。Agent を起動しない状態で開き、「セットアップ未完了」を通知し、`/sandbox off` は受け付ける（fail-closed は保つ）
5. broker の token が command line に出る（`windows-platform.ts:111, 125, 128`）。人の権限で開いたファイルを stdin に渡すなどして、argv に載せない
6. bootstrap の PowerShell が、agent の書けるモジュールのパスを読む恐れがある。PowerShell を使わない起動にするか、最初に `PSModulePath` を `$PSHOME\Modules` に固定し、組み込みの API だけを使う
7. 継承付きの ACL を付けるとき、project の中の junction・symlink をたどって、人のディレクトリに Modify を伝播しないか実測する。たどるなら、伝播の前にリンクを検出して止める
8. off の release の失敗で Agent が止まったまま戻らない（`controller.ts:255-258`、`workspace.ts:127`）。失敗時は sandbox のまま起動し直し、通知する
9. 実行環境のディレクトリが毎回作られて消えない（`windows-platform.ts:104-108`）。中身のハッシュで使い回す
10. `clearAllSessions` が無題の会話のタイトルを固定する（`conversation-history.ts:138-139`）。sessions だけを空にする

low:

- prepare の後の stop の失敗、off のときに残った lease を外す経路がない
- `safe.directory` の比較を正規化する（大文字小文字・区切り文字・末尾）。`--add` の失敗を無視しない
- `validateSandboxPath`: `~/.clodex`・`AppData` 配下の project を拒否する
- Hub 側の broker の listen は、認証の後に close する
- マジックナンバー（`windows-platform.ts:128` の `1500`、`broker-source.ts` の `'4294967295'`・`30000`、`windows-platform.ts:68` の `slice(0, 16)`、`broker.ts:68` の `includes(10)`）を定数にする
- platform のエラーと `shell.ts` の `sandbox: on/off` を i18n に通す。`/sandbox` にセットアップ済みかどうかを出す
- `broker.ts:74` の `as` を zod に置き換える。`src/index.ts` の連続した空行を消す
