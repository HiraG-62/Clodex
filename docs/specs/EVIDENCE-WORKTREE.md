# EVIDENCE-WORKTREE: worktree の中の作業でも証跡を働かせ、通知と計測の重複を除く

roguelike の運用（10/17〜10/18、DELEGATE 27 件）で、統合役が project の中の git worktree（`.claude/worktrees/quarter-view`。project の `.gitignore` の対象）で作業していた。Clodex は基準点を会話の作業ディレクトリ（本体）で取るので、`changed` が 27/27 件で空になり、envelope は見出しだけの空行で「変更なし」と読めた。あわせて、週の利用ペースの通知が会話・並列の子の会話ごとに重ねて出て（10 回中 7 回）、並列の子の message が親と子の両方に記録されて project 全体の集計で二重に数えられた（DELEGATE 27 件が 34 件）。

仕様の正は `docs/DESIGN.md` の次の箇所。

- §13「検証の証跡」の基準点（別の作業ツリーの spec）と envelope（場所と `(none)`）
- §14 利用枠の通知の「1 回は Hub 全体で数える」
- §17「task 単位の計測」の重複の除き方
- §13 Roles「定型文の作法」の同じ taskId での再依頼

## 固定（挙動・不変条件・公開インターフェース・編集範囲）

### 1. 別の作業ツリーの spec（`src/coordinator/work-baseline.ts`・`coordinator.ts`・`spec-check.ts`）

- 依頼の `spec`（project root からの相対。`.claude/worktrees/quarter-view/docs/specs/x.md` のような path は今も受け付ける）の実パスのディレクトリで `git rev-parse --show-toplevel` を取り、会話の作業ディレクトリの toplevel と違えば、その toplevel を「依頼の作業ツリー」とする。同じか、spec が無い・git の外なら今どおり会話の作業ディレクトリ
- 依頼の作業ツリーで、基準点（`HEAD`・変更のあるファイル）・RESULT の差分・`specCheck` の実行を行う。範囲の glob は依頼の作業ツリーからの相対 path で当てる。依頼元の編集の印（`peer`）も、依頼の作業ツリーからの相対 path にそろえて比べる（外のファイルは比べない）
- `WorkBaselines` は今 1 つの root で作られている。依頼ごとに root を持てる形にする
- `evidence` に差分を計算した場所 `root`（絶対 path）を足す。envelope は `Changed since the request (working tree <root>):`、変わったファイルが無ければ次の行に `- (none)`。画面のカードにも場所を小さく出し、無ければ「なし」

### 2. 利用枠の通知を Hub 全体で 1 回にする（`src/coordinator/usage-monitor.ts` と、それを作る `src/hub/`）

- `notifyOnce` の「通知済み」の記録を、UsageMonitor ごとではなく Hub で 1 つ共有する（ProjectContext を越えて共有してよい。利用枠は Agent のアカウント単位なので project をまたいでも同じ）。共有の入れ物は Hub が作って各 Coordinator に渡す。渡されなければ今どおり UsageMonitor の中に持つ（テストのため）
- 対象は利用枠の通知（週のペース・5 時間枠）。`threadTokenWarn` は session ごとなので今どおり

### 3. 計測の重複（`scripts/task-metrics-baseline.ts`・`src/coordinator/task-metrics*.ts`）

- 基準値の script は Event Log の `message` を message ID で重複を除いてから数える（並列の子と親のログの両方にある）
- `TaskMetricsStore` の会話ごとの集計は今どおり（親の RESULT のカードに要る）。project 全体を集計する関数があれば message ID で除く。無ければ作らない

### 4. 定型文（`src/context/role-instructions.ts`）

- 1 行足す: `To request rework of a task, send it with the same taskId and set rework (spec, impl or check); do not create a new taskId.`
- `rework` の `describe`（`src/protocol/messages.ts`）にも「同じ taskId で送る」を短く足してよい

## 裁量

- `git rev-parse --show-toplevel` の呼び出しの置き場所（受理時か配送の直前か）。結果は依頼ごとに覚えてよい
- 共有の入れ物の型と、Hub から渡す経路

## テスト方針

- 一時ディレクトリに本体の repo と、その中の `.gitignore` された git worktree を作り、worktree の中の spec を付けた依頼で、worktree での変更が `changed` に入り `scope` が当たる。`root` が worktree。会話の作業ディレクトリと同じ作業ツリーの spec なら今どおり
- envelope: 変わったファイルが無いとき `- (none)`、場所の行
- `specCheck` が依頼の作業ツリーで動く
- 利用枠の通知: 2 つの Coordinator（親と子、別の project）で同じ条件を満たしても 1 回だけ。reset 後は再び
- script: 同じ message ID が 2 つのファイルにあっても 1 回だけ数える
- 定型文の 1 行
- 最後に `pnpm test`・`pnpm typecheck`・`pnpm lint` を 1 回ずつ。コミットはしない

## 触ってよいファイル

- `src/coordinator/**`、`src/hub/**`、`src/context/role-instructions.ts`、`src/context/context-resolver.ts`、`src/protocol/messages.ts`、`src/web/client/**`（カードの場所の表示）、`src/tui/**`、`src/i18n/messages.ts`、`src/index.ts`、`scripts/task-metrics-baseline.ts` とそれぞれのテスト
- 生成コマンドが書き換えるファイル
- `docs/DESIGN.md` は触らない（矛盾を見つけたら QUESTION）
