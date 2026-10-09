# CORE-ROBUST-1: Hub と Agent が例外や同時操作で止まらないようにする

3 件の独立した修正。コミットは件ごとに分けるので、RESULT では件ごとに変更したファイルを書く。仕様は docs/DESIGN.md の次の行（今回追記済み）。

- §9 Adapter:「ターンの入力をプロセスに書けなかったとき…」
- §18 Hub の再起動からの復旧:「保存に失敗しても Hub を止めない…」
- §28 D:「同じ会話の ConversationRuntime、同じ project の ProjectContext を作る要求が重なっても…」

## A. ターンの書き込み失敗で busy のまま固まる

現状: `src/agents/base-agent-adapter.ts` の `beginTurn` は、`status = "busy"` と `resolveTurn` を設定してから `write()` を呼ぶ。`write()` が同期で throw すると（Claude の `imageBlock` の `readFileSync`、sandbox の broker の `send`）、例外は呼び出し元に伝わるが、adapter は busy のまま残る。以後の送信は `claude is busy` で失敗し続け、`/new`・`/resume` もできない。

変更:
- `write()` の例外を受け止め、`finishTurn({ status: "failed", text: <エラーの文言> })` でターンを終える。返す Promise はその結果で解決する（reject しない。他の失敗したターンと同じ扱い）
- quiet なターンでも同じ（`finishTurn` が quiet を見て event を出さない）

テスト（`src/agents/base-agent-adapter.test.ts` を新規作成するか、既存の claude-adapter のテストに足す）:
- `write` が throw したら、`send` の結果が `failed` で、文言にエラーの内容が入り、status が `idle` に戻る
- その直後の `send` が `busy` で拒否されない

## B. 復旧状態の保存失敗で Hub が落ちる

現状: Agent の event（turn_started・text・tool・turn）ごとに `Coordinator.notifyRecoveryChange` → `Workspace` → `src/hub/project-context.ts` の `save`（`saveRecovery` → `writeFileAtomic`）が、Agent の stdout の line handler の中で同期で走る。Windows ではウイルス対策ソフトやインデクサがファイルを開いていると `renameSync` が `EPERM`/`EBUSY` になり、`uncaughtException` から fatal で Hub が終了する。

変更:
1. `src/project/atomic-write.ts`: `renameSync` が `EPERM`・`EBUSY`・`EACCES` で失敗したら、短く待って再試行する（最大 3 回、間隔 20ms 程度。同期関数のままにするため `Atomics.wait` で待つ）。回数と間隔は定数にする。再試行しても失敗したら今どおり throw する。一時ファイルの後始末（`unlinkSync`）の失敗で元の例外を隠さない
2. `src/hub/project-context.ts` の復旧状態の `save`: 例外を受け止め、同じファイルの `feedSaveFailed` と同じ形で stderr に出す。最初の失敗だけ出し、保存に成功したらフラグを戻す（DESIGN の記述どおり）

テスト:
- `writeFileAtomic`: rename が 1 回 `EPERM` で失敗しても書き込みが成功する。毎回失敗するなら throw する（`node:fs` の `renameSync` を `vi.mock` か依存の注入で差し替える。注入にするなら引数を増やしすぎない）
- project-context の save の失敗が呼び出し元に伝わらないこと。テストが重くなりすぎるなら、save の失敗の扱いを小さな関数に切り出して、そこをテストしてよい

## C. 同じ project・会話を同時に開くと二重に作られる

現状:
- `src/hub/hub.ts` の `open` は `contexts.get` → `await openProject` → `contexts.set` の間にガードがない
- `src/hub/workspace.ts` の `ensure` も `runtimes.get` → `await createRuntime` → `runtimes.set` で同じ形
- Web の入力（`/api/input`）は直列化されていないので、スマホと PC から同時に `/project X` や会話の切り替えが届くと 2 つ作られ、先に作った方（MCP server・Coordinator・Agent）が誰にも閉じられずに残る

変更:
- 作成中の Promise を Map で持ち、同じキーの要求はそれを待って共有する。作成に失敗したら Map から消し、次の要求で作り直す
- `ensure` の後続の処理（listener の登録、`runtimeListeners` の通知）は 1 回だけ行う

テスト（`src/hub/hub.test.ts`・`src/hub/workspace.test.ts` の既存の形に合わせる）:
- 同じ project の `open` を 2 回並行に呼ぶと、`openProject` は 1 回だけ呼ばれ、両方が同じ context を返す
- `openProject` が 1 回失敗したあと、次の `open` で作り直せる
- 同じ会話の `ensure`（を呼ぶ公開メソッド）を並行に呼ぶと、`createRuntime` は 1 回だけ

## 変更してよいファイル

- `src/agents/base-agent-adapter.ts` と、そのテスト（新規可）、`src/agents/claude-adapter.test.ts`
- `src/project/atomic-write.ts`、`src/project/atomic-write.test.ts`（新規可）
- `src/hub/project-context.ts` と、そのテスト
- `src/hub/hub.ts`、`src/hub/hub.test.ts`、`src/hub/workspace.ts`、`src/hub/workspace.test.ts`

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
