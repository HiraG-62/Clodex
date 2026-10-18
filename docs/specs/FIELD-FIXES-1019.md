# FIELD-FIXES-1019: 運用で見つかった 3 件（範囲の除外・worktree の並列・git の index）

roguelike の運用で出た 3 件を直す。仕様の正は `docs/DESIGN.md`（claude が更新済み。触らない）。

## 1. 設計書の範囲の除外（DESIGN.md §13「設計書の検査」の直前、`specSections` の項）

起きたこと: 編集禁止の節に「- 本体（`*.test.ts` 以外）すべて。`src/map/layout/**` は並行の B2c が worktree で編集中」と書いた設計書で、所有のテストファイルに `forbidden` が付いた。`src/coordinator/work-baseline.ts` の `patterns` が、箇条書きのバッククォートをすべて範囲として拾うため。

### Fixed
- 範囲のトークンを「範囲」と「除外」に分ける
  - `` `!glob` `` は除外（`!` を除いた glob）
  - 直後に「以外」が続く `` `glob` ``（間に空白があってもよい）は除外
  - それ以外は今どおり範囲
- 節（owned / forbidden それぞれ）に当たる条件: どれかの範囲に当たり、どの除外にも当たらない。範囲が無く除外だけある節は、範囲を `**` とする。範囲も除外も無ければ今どおり分類しない
- forbidden を owned より先に判定する順は変えない
- 上の例の設計書で、`src/system/foo.test.ts` は forbidden にならない（テストで確かめる）。`src/map/layout/a.ts` は forbidden
- `specSections` が設定されているときだけ、役割の定型文（`src/context/role-instructions.ts`）に 1 行足す: `In the "<owned の見出し>" and "<forbidden の見出し>" sections of a spec, backticked paths or globs in bullet items define the scope. Write exceptions as `!glob`.`（片方だけ設定されていればその節だけを書く。言い回しは任せる）。`buildRoleInstructions` に `specSections` を渡す経路が無ければ足す（`verify` と同じ渡し方）

## 2. `worktree: true` の並列の依頼が本体で動いた（DESIGN.md §11 Message Schema の `parallel` / `worktree`、§28 D「子の会話で並列に受ける」）

起きたこと: `parallel: true, worktree: true` の DELEGATE を、宛先が待機中のときに送ると、`src/coordinator/coordinator.ts` の `receiveMessageFromTool` の `message.parallel && (busy || !mailbox.isIdle)` が偽になり、通常の配送で本体の作業ツリーで動いた。

### Fixed
- `message.parallel && (message.worktree || 宛先が作業中)` なら子の会話を立てる。`worktree` なしの `parallel` の扱い（待機中なら通常の配送）は変えない
- 子の会話・worktree の作り方、拒否の文言、Budget の扱いは今と同じ
- テスト: 宛先が待機中でも `worktree: true` なら `startParallel` が呼ばれる／`worktree` なしで待機中なら呼ばれない

## 3. git の index（DESIGN.md §13「定型文の作法」）

起きたこと: 実装役が `git rm` でステージした削除が、統合役の別のコミットに混ざった。

### Fixed
- 役割の定型文に 1 行足す（常に。ブレストには不要）: `Only the agent that commits changes the git index (git add, git rm, git mv, git stash). Otherwise delete or move files with normal file operations.`（言い回しは整えてよいが、4 つのコマンド名と「普通のファイル操作で」は残す）

## 編集してよいファイル
- `src/coordinator/work-baseline.ts`、`src/coordinator/work-baseline.test.ts`
- `src/coordinator/coordinator.ts`、`src/coordinator/coordinator.test.ts`、並列のテストがある既存の test ファイル
- `src/context/role-instructions.ts`、`src/context/role-instructions.test.ts`
- `buildRoleInstructions` の呼び出し元（`specSections` を渡すため。`verify` を渡している箇所）
- `src/context/spec-sections.ts`（範囲の解析をこちらへ移すなら）

## Discretion
- 範囲と除外の解析を純関数としてどこに置くか
- 「以外」の判定の正規表現の細部（全角の空白、`の` を挟む形などに広げてよい）
- テストの粒度

## 完了の条件
- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く
