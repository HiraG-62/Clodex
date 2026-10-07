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

## レビュー対応中のプロセス保護の計測

`spikes/sandbox-process-access.ts` で、制限された Agent から helper・broker・起動元に対するハンドル取得だけを計測した。コード注入や偽装そのものは実行していない。以下は途中結果であり、安全性の確認は未完了。

| 操作 | 修正前 | 現在の試験用 DACL |
|---|---|---|
| OpenProcess: CREATE_THREAD・VM_WRITE・DUP_HANDLE | 成功 | Access denied |
| OpenProcess: VM_READ・WRITE_DAC・QUERY_LIMITED_INFORMATION | 成功 | Access denied |
| OpenThread: SUSPEND_RESUME・SET_CONTEXT | 成功 | Access denied |
| OpenThread: IMPERSONATE・DIRECT_IMPERSONATION | 未計測 | 成功・未解決 |

- agent の SID への許可を外し、人・SYSTEM と Authenticated Users の ACE を使用。Authenticated Users は restricting SID に含まれない。OWNER RIGHTS の ACE で所有者に暗黙に付く WRITE_DAC も抑えた。
- プロセスの DACL から問い合わせ権限も外した。その前の構成では、問い合わせ用ハンドル経由で OpenProcessToken の DUPLICATE・IMPERSONATE が成功した。
- default DACL から Authenticated Users を完全に外す構成や、スレッドの偽装権限のビットを全オブジェクトに対して拒否する構成は、Node の初期化が停止した。権利のビットの意味はオブジェクトの種類によって異なる。
- WRITE_RESTRICTED を外した token の比較実験は、読み取りの範囲も変わるため設計確認中。現在の試験用 DACL は製品の保護が完成したものとして扱わない。

### 通常 restricted token の比較実験

承認後、`CreateRestrictedToken` の flags を `0` に変更。restricting SID は agent・logon・Everyone・Users のまま。Agent の default DACL は agent・logon・SYSTEM、broker 側は Authenticated Users・人・SYSTEM の Full Control と OWNER RIGHTS の ReadControl とした。broker 側に agent・logon・Everyone・Users の Allow は付けない。

同一 run `9d285c41-32e1-458d-ade8-041c0c93a1d1` の結果。生ログは `C:\Users\Horry\.clodex\sandbox-process-access-9d285c41-32e1-458d-ade8-041c0c93a1d1.json`。

| 計測 | 結果 |
|---|---|
| helper・broker・bootstrap の OpenProcess | ALL_ACCESS・QUERY_INFORMATION・QUERY_LIMITED_INFORMATION・DUP_HANDLE・VM_WRITE・CREATE_THREAD を個別に試し、すべて error 5 |
| 同プロセス群の OpenThread | 列挙できた全スレッドの IMPERSONATE・DIRECT_IMPERSONATION・SET_CONTEXT が error 5 |
| OpenProcessToken / DuplicateTokenEx | 前提の process QUERY ハンドル取得で拒否。後段 API 自体には未到達 |
| NtImpersonateThread | 前提の source thread DIRECT_IMPERSONATION ハンドル取得で拒否。API 自体には未到達 |
| PowerShell 5.1 / 7 | 5.1.26100.9444 / 7.6.6、起動成功 |
| Node の子プロセス | 起動・stdout 取得成功 |
| HKCU | 一時キーの作成・読み取り・削除成功 |
| Claude / Codex | 2.1.291 / 0.160.1、版表示成功。ターン未実行 |
| git init / commit | 成功。agent の呼び出しに計測用 repo の safe.directory を指定。人の設定は未変更 |
| HTTPS / localhost MCP initialize | HTTP 200 / initialize 応答取得成功 |
| E:・Program Files・agent profile の一覧 | 成功 |
| 人の profile の一覧 | EPERM |
| pnpm install --ignore-scripts | hard link 作成で os error 5 |
| pnpm install --ignore-scripts --package-import-method=copy | 成功、is-number 7.0.0 をインストール |

pnpm 12.9.1 の失敗対象は、`E:\dev\clodex-hybrid-test\.pnpm-store\v11\files\72\392bccd8964c88ec8aa3d815746a2b6a4466d9c7ca8f428d7d0f3e2bb11674ef494ca335c8b255eee5825c087a77bb45a5d60025f318b78a64e19beccd23c7` から計測用 repo の `node_modules\.pnpm\is-number@7.0.0\node_modules\is-number\LICENSE` への import。同じ source に対する Node の readFileSync・copyFileSync は成功、linkSync は EPERM。拒否を返したファイル操作は特定したが、カーネル内部でどの照合が失敗したかは未特定。copy 方式を製品設定にするか QUESTION で確認中。

最初の pnpm 起動失敗は `.cjs` 固定の resolver による MODULE_NOT_FOUND だった。実機の pnpm は `.mjs` なので、両形式の解決と回帰テストを追加した。git の最初の commit 失敗は safe.directory 指定不足で、上表は指定後の結果。

旧実験の「broker default DACL から Authenticated Users を外すと Node の初期化が停止する」現象は、拒否対象オブジェクトをまだ特定できていない。今回の Authenticated Users を許可する構成では再現していない。原因解明済みとは扱わない。

`pnpm test`: 728 passed / 5 skipped、`pnpm typecheck` 成功。レビュー指摘全体の対応は継続中。

### 採用構成での最終確認

通常 restricted token を採用。run `708fda3d-5b21-44b8-be12-7124a84bf7e6` で上記のプロセス・スレッドのハンドル取得拒否、PowerShell・HKCU・Node 子プロセス・git commit・CLI の版・HTTPS・MCP を再確認した。

pnpm の copy は Agent の環境変数だけに設定し、project の設定ファイルは変更しない。指定された `npm_config_package_import_method=copy` に加え、pnpm 11 以降向けの `pnpm_config_package_import_method=copy` を設定する。pnpm 12.9.1 は前者だけでは設定値が undefined、後者を加えると copy になり、引数に copy を付けない `pnpm install --ignore-scripts` が成功した。[pnpm の移行資料](https://github.com/pnpm/pnpm.io/blob/main/docs/migration.md)。hard link 拒否のカーネル内部の原因は未特定。

`spikes/sandbox-git-protection.ts` では、人が作った計測用 repo と worktree に製品の ACL を適用した。

| 操作 | 結果 |
|---|---|
| `.git/config` / `config.worktree` の書き込み | EPERM |
| `.git/hooks/pre-commit` の作成 | EPERM |
| worktree の `.git` ファイルの書き込み | EPERM |
| `.git` の rename | EPERM |
| 保護中の git commit | 成功 |
| 解除後の config 内容 | 元と一致 |

git の保護対象には agent の書き込み・削除に加え ACL 変更・所有権変更の Deny を設定する。OWNER RIGHTS の ReadControl で、所有者に暗黙に付く WRITE_DAC を抑える。人による解除と継承の更新ができるよう、人の Full Control も同時に明示する。これらの ACE を付与前後の journal に含め、解除時に元へ戻す。試験途中の OWNER RIGHTS だけの構成で人による解除が失敗した fixture は、管理者操作を使わず計測用ファイル・ディレクトリを復元済み。全計測 journal の lease は 0 件、計測 helper の残存なし。

`spikes/sandbox-acl-links.ts` では、project 内に junction と directory symlink をそれぞれ作り、外側の人の Temp にあるディレクトリ・子ディレクトリ・ファイルの SDDL を比較した。どちらもリンク先の変更なし。fixture の ACL は復元し、リンクを削除した。

残りの回帰確認はユニットテストで実施。初期化失敗時の起動禁止と off 復帰、削除済み worktree のスキップと lease 解除、off 失敗時の sandbox 再起動、prepare 後の停止失敗の後片付け、会話タイトル保持、認証後の待受終了、git の fsmonitor・hook・外部 diff の無効化を含む。

broker の配置先は `%ProgramData%\Clodex-Sandbox-<human SID>\<content hash>`。コード・Node・環境設定・ログインスクリプトのハッシュで再利用し、親ディレクトリは作成時に保護した DACL を指定する。agent の bootstrap は native helper に置き換え、接続 token は人が開いた stdin から渡す。

## 専用ユーザー再作成後の復旧

SID が変更された場合、古い runtime の RX と project journal が復旧を妨げる。人が所有する runtime の ACL を現在の SID に再構築し、古い SID の journal は記録先の明示 ACE を解除して再作成する。uninstall は runtime と journal も除去する。`/sandbox` の例外は shell で表示し、入力 API へ送出しない。実機確認は `spikes/sandbox-debug-probe.ts` の inspect / connect(false) / setupStatus に限定する。

2026-10-07 の実機確認で、旧 SID 末尾 `1005` から新 SID 末尾 `1006` への復旧に成功。probe を 2 回実行し、両方とも inspect=true、connect(false)・setupStatus・close は例外なし。runtime の RX は新 SID のみ、3 件の journal はすべて新 SID・lease 0 件になった。ユーザー・資格情報・managed は true、CLI 3 種と authenticated は false。UAC・CLI インストール・ログイン・実 CLI のターンは未実行。

Web の 500 は `src/cli/shell.ts` の sandbox 分岐からの例外が `src/index.ts` の onInput を通って `src/web/web-server.ts` の共通 500 応答まで伝わったもの。sandbox 分岐内で捕捉して print し、実際の POST /api/input を使うテストでエラー表示と HTTP 204 を確認した。

ユニットテストでは、非空の旧 journal の ACE 復元、途中失敗時の journal 維持、復旧の再実行、runtime の所有者・reparse point 検査、uninstall → 再作成 → uninstall の runtime / journal 除去を確認。実際の uninstall は管理者操作を伴うため未実行。

## npm による CLI インストール

2026-10-07、`pnpm exec tsx spikes/sandbox-debug-probe.ts --install` を実行。restricted token の broker 経由で `npm install --global @anthropic-ai/claude-code @openai/codex pnpm` が成功し、3 CLI の `--version` も成功した。保存先は agent の `%APPDATA%\npm`。UAC・ログイン・CLI のターンは実行していない。

| 判定 | 実行前 | インストール後 |
|---|---|---|
| inspect / connect(false) | 成功 | 成功 |
| managed / user / credential | すべて true | すべて true |
| claude / codex / pnpm | すべて false | すべて true |
| authenticated | false | false |

[npm registry の Claude 配布情報](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)では、確認時点の 2.1.292 の Windows entry は `bin/claude.exe`。broker の起動と setupStatus は npm の `node_modules/@anthropic-ai/claude-code/bin/claude.exe` を参照し、PATH も npm を先頭にする。

broker は stdout / stderr を別々に転送し、失敗・タイムアウト・起動失敗のメッセージに各最大 8 KiB の末尾を付ける。stderr は Agent の行プロトコルには渡さない。

DESIGN.md §9「制約」への追記案: restricted token 内では Windows PowerShell 5.1 の HTTPS（`Invoke-WebRequest` / `Invoke-RestMethod` など）が失敗する。CLI のインストールには Node の HTTPS を使う npm を使用する。

restricted token 内の Windows PowerShell 5.1 で HTTPS に失敗するため、Claude・Codex・pnpm を npm でインストールする。判定・起動先・PATH は agent の npm prefix に統一し、broker.run の失敗には stdout / stderr の末尾を含める。検証には `spikes/sandbox-debug-probe.ts --install` を使い、ログインと CLI のターンは実行しない。

## 実機の確認で見つかった問題（2026-10-07）

- Windows PowerShell 5.1 の `Start-Process -Credential` に `-Wait` を付けると、`Access is denied`（5）で起動に失敗する。`-Wait` は子プロセスを Job object に入れて待つため、別ユーザーのプロセスでは失敗すると見られる。`-Wait` を外して `-PassThru` の `WaitForExit()` で待てば起動できる。ただし、別ユーザーのプロセスの終了コードは取れない（`ExitCode` が空になる）
- `CreateProcessWithLogonW` を直接呼ぶ場合は、ドメインの指定（`.` か PC 名か）、環境変数のブロック、`lpDesktop` によらず成功した
- `Start-Process -Credential` で起動したコンソールのプログラムは、新しいウィンドウを作らず、呼び出し元のコンソールに相乗りする。GUI の Hub は見えないコンソールで動くため、ログイン用の PowerShell が画面に出なかった。`cmd.exe /c start "<title>" /wait …` を挟むと別ウィンドウで開く
## sandbox の再有効化と Hub の診断

`spikes/sandbox-reenable-probe.ts` は `openProject` を使って off → on → off → on を行い、起動と startup probe だけで未処理例外を監視する。終了時に元の sandbox 設定へ戻す。実 CLI のターンは送らない。

2026-10-07 の初回調査では、sandbox 側の `account/read` が未認証を返し、Codex の起動が失敗した。コマンド例外を捕捉して切り替えを続けた実行は未処理例外 0 件。保存済み authenticated=true だけでは、現在の認証成功を保証していない。元の GUI クラッシュとの同一性は未確認。

GUI が起動する Hub の stderr は、人の `~/.clodex/logs/hub-<Unix時刻ミリ秒>-<一意値>.log` に保存する。標準入力と標準出力の扱いは従来どおり。

Hub は unhandledRejection と EPIPE / ECONNRESET / ERR_STREAM_DESTROYED をログへ記録し、error として表示して継続する。その他の uncaughtException と起動の失敗は同期的に stderr と `hub-errors-<時刻>-<pid>.log` に記録して終了コード 1 で終了する。`~/.clodex/hub-failure.json` の異常終了記録を GUI 次回起動時に一度通知する。

再現時の Hub は作業ツリーの dist を使用していたと確認された。調査時の dist/cli/shell.js の更新時刻は16:24:07で、クラッシュ記録は16:27:57。同梱runtimeの古さを原因とする根拠はない。

## sandbox の認証判定

モデル一覧と利用状況の応答は未ログインでも返り、認証の証明にならない。sandbox の検査を `claude auth status --json` の loggedIn=true / authMethod=claude.ai と、Codex app-server の account/read の account.type=chatgpt に変更。認証方式の許可値は src/sandbox/authentication.ts の定数にまとめ、通常の Adapter は変更しない。

setupStatus は毎回実検査し、sandbox-setup.json の authenticated=true を合格の根拠にしない。保存済み on の起動は認証未完了なら Agent を起動しない。on の再実行でも未完了を検出すればセットアップに入り、失敗時は起動禁止を保つ。

2026-10-07 の実測（メールアドレス・ID は記録しない）:

| Claude auth status --json のフィールド | agent 未ログイン | 人の既存ログイン |
|---|---|---|
| loggedIn | false | true |
| authMethod | none | claude.ai |
| apiProvider | firstParty | firstParty |
| subscriptionType | フィールドなし | max |
| 終了コード | 1 | 0 |

agent の応答には analyticsDisabled=false、projectsDirectory=`C:\Users\clodex-agent\.claude\projects`、configDirectory=`C:\Users\clodex-agent\.claude` も含まれた。[CLI reference](https://code.claude.com/docs/en/cli-reference) の認証方式・終了コードの仕様とも一致した。

`pnpm exec tsx spikes/sandbox-auth-probe.ts` は authentication={claude:false,codex:false}、authenticate=false、setupStatus.authenticated=false。他の setupStatus 項目（managed/user/credential/claude/codex/pnpm）は true。保存済み authenticated=true のままでも誤合格しないことを確認した。資格情報マネージャーの仮説は、人が一度もログインしていなかったとの訂正で調査終了。

人の操作: 修正をビルドして Hub を再起動し、`/sandbox on` を実行。開いた agent 用 PowerShell で `claude auth login` と `codex login` を行ってウィンドウを閉じる。その後の実検査で合格したときだけセットアップ完了となる。agent のログイン後の応答は、人のログイン後に再計測する。今回 UAC・ログイン・実 CLI ターンは実行していない。

認証修正後の再有効化 probe でも未処理例外は0件。未認証の on は probe がセットアップ前に止めるため、UAC とログイン画面を起動しない。元のクラッシュ原因の特定、およびログイン後の on → off → on の確認は未完了。

検証: pnpm test は763件成功・5件skip、pnpm typecheck 成功、GUI の cargo test --lib は2件成功。コミットを分ける場合、Hub 診断は src/hub/runtime-errors*・src/index.ts・gui/src-tauri/src/lib.rs・spikes/sandbox-reenable-probe.ts、認証判定は src/sandbox/authentication*・controller*・windows-platform*・spikes/sandbox-auth-probe.ts。記録の本ファイルは各節で分ける。
