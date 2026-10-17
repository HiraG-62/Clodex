# VERIFY-EVIDENCE: 検証プロファイル・RESULT の証跡・設計書の検査

「テストを通した」「設計書に従った」が Agent の自己申告に頼っている。Coordinator が記録から分かる事実（実行した検査コマンドと終了コード、依頼開始後の作業ツリーの差分と設計書の範囲による分類）を `RESULT` に添え、設計書を検査する project のコマンドを依頼の受理時に診断として回す。受入の判断はしない。仕様の正は `docs/DESIGN.md` §13「検証の証跡」「設計書の検査」、§11 Message Schema の `evidence`・`specCheck`、§13 Roles の設定のキー。

前提: §9「コマンドの記録」（`tool` の `command`・`exitCode`、`tool_end`、WorkRecorder の `commands`）と §13「Spec の差分」の配送直前の準備（`prepareMessage`・`prepareSpec`）は実装済み。

## 変更

対象のファイルは目安。同じ目的に要るファイルは確認せずに触ってよい。

### 1. 設定（`src/config/config.ts`）

- `verify: { implement?: string[]; integrate?: string[] }`、`specSections: { owned?: string; forbidden?: string }`、`specCheck?: string` を schema に足す。オブジェクトはキーごとに重ねる（「設定の層」の `OBJECT_CONFIG_KEYS` に足す）

### 2. 定型文（`src/context/role-instructions.ts`）

- `verify` があれば 1 行足す: `Default checks: implement = <a; b>; integrate = <c; d>. Run the default checks for your step plus any checks the spec adds.`（片方だけなら片方）。ブレストには入れない
- envelope には書かない

### 3. 基準点（`src/coordinator/`。新しいファイルにしてよい。例: `work-baseline.ts`）

- `DELEGATE` の配送の直前（`prepareMessage` と同じ時点。steer で足すときも）に、宛先の作業ディレクトリ（その会話の `projectRoot`。worktree の会話ならその worktree）で:
  - `git rev-parse HEAD`、`git status --porcelain=v1 -z --untracked-files=all` の各ファイルの中身の SHA-256（消えたファイルは「無い」と記録）
  - 依頼 ID ごとにメモリに持つ。git の外・失敗したら記録しない（配送は止めない）
- git の実行は同期でよいが、時間がかかる場合に備えて 10 秒で打ち切る

### 4. 証跡（`RESULT` の受理時。`coordinator.ts` の `accept` と `autoReply`）

- `RESULT` の `replyTo` が基準点のある依頼（`FIX`・`ADD` への `RESULT` は元の依頼）なら、`evidence` を作って message に付ける（Coordinator が付けるフィールド。Agent の入力では受け付けない）
  - `checks`: 依頼の配送から今までに宛先の Agent が実行したコマンドを集める（WorkRecorder の `commands` はターンごとなので、依頼ごとに配送からのコマンドを貯める仕組みを足す）。`verify.implement` の各コマンドについて、そのコマンド文字列を含む最後のコマンドの結果 `{ command, exitCode?, failed?, ran: boolean }`
  - `changed`: 基準点の `HEAD` から今の作業ツリーまでの変更（`git diff --name-only <HEAD>` と今の `git status` のファイルを合わせる）から、基準点と中身の SHA-256 が同じファイルを除く。各ファイルに `scope`（`owned` / `forbidden` / `outside`。`specSections` と依頼の `spec` があるときだけ）と `peer: true`（依頼の間に依頼元の Agent の `tool` event の `files` に出た）。100 件を超えたら `{ count }` だけ
  - `scope` の判定: 依頼の `spec`（受理時の中身でよい）を見出しで節に分け（`changedSections` の節の分け方を流用）、`specSections.owned` / `forbidden` と見出しの文字列が一致する節の箇条書きの `` `path` ``（バッククォートの中）を glob として `path.matchesGlob` で判定。`forbidden` に当たれば `forbidden`、`owned` に当たれば `owned`、どちらでもなければ `outside`。path は project root からの相対・`/` 区切りにそろえる
- 依頼元の編集の記録は、今の `deliveryNotes.recordPeerFiles`（止まっている間だけ）とは別に、依頼ごとに常に貯める
- envelope（`src/context/context-resolver.ts`）: `RESULT` の末尾（返信の指示の前）に `Evidence (recorded by Clodex):`、検査の行（`- pnpm test: exit 0` / `failed` / `not run`）、`Changed since the request (working tree):` とファイルの行（`- src/a.ts [owned]`、`[forbidden]`、`[outside]`、依頼元の編集は ` (also edited by <agent>)`）
- 画面: `RESULT` の message カード（Web UI と TUI）に、検査の結果を小さなチップ（コマンドと exit の値。失敗は警告色）と、変わったファイルを折りたためる一覧で出す（`forbidden`・`outside` は目立たせる）。文言は短く（ja「依頼開始後の差分」など）。既存のカードの部品・`task-metrics-format` の並びに合わせる

### 5. 設計書の検査（`specCheck`）

- `spec` 付きの `DELEGATE` / `REVIEW_REQUEST` を受理したら、宛先の作業ディレクトリで `specCheck` の `{spec}` を設計書の path（project root からの相対）に置き換えて shell で実行する（60 秒で打ち切る。Windows の既存の command 実行の仕組みがあれば使う。`src/cli/command-runner.ts` などを確認）
- 結果 `{ command, exitCode?, timedOut?, output }`（出力は stdout と stderr の末尾 20 行。2,000 文字まで）を message の `specCheck` に付ける。配送はその完了を待つ（`deliver` の前に await）。拒否はしない
- envelope に `Spec check (<command>): exit <code>`（打ち切りは `timed out`）と出力をコードブロックで。画面の message カードにも折りたためる形で
- Event Bus の `message` は受理時に出るので、`specCheck` は結果が出てから付けた message を画面に反映する方法を決める（例: 検査が終わってから `message` を publish する。順序が変わるなら QUESTION）

## テスト方針

- 設定: `verify`・`specSections`・`specCheck` の読み込みと層
- 定型文: `verify` の 1 行
- 基準点と証跡（一時ディレクトリに git の repo を作る実ファイルのテスト）: 依頼の後に変えたファイルが `changed` に入り、元から dirty で中身が同じファイルは入らない。commit したファイルも入る。`scope` の分類（glob を含む）。依頼元の編集の印。基準点が無ければ `evidence` を付けない。100 件超
- checks: 依頼の間の `command` / `Bash` の終了コード・失敗・未実行。別の依頼の間のコマンドは混ぜない
- auto RESULT にも `evidence` が付く
- specCheck: 成功・失敗・打ち切り。envelope の行。`specCheck` 未設定なら何もしない
- 画面: CLAUDE.md の「画面の確認（Web UI）」の手順で、`evidence` と `specCheck` の付いた message を feed に差し込み、PC とスマホ幅のスクリーンショットを `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に撮り、RESULT に path を書く
- 最後に `pnpm test`・`pnpm typecheck`・`pnpm lint` を 1 回ずつ。コミットはしない

## 触ってよいファイル

- `src/config/**`、`src/context/**`、`src/coordinator/**`、`src/protocol/messages.ts`、`src/project/**`、`src/hub/**`、`src/index.ts`
- `src/web/**`（`client/` を含む）、`src/tui/**`、`src/i18n/messages.ts`
- それぞれのテスト、生成コマンドが書き換えるファイル
- `docs/DESIGN.md` は触らない（矛盾を見つけたら QUESTION）
