# CORE-ROBUST-2: Agent の応答が止まったときと、配送の失敗が消えるときの対策

CORE-ROBUST-1 の続き。独立した 4 件。コミットは件ごとに分けるので、RESULT では件ごとに変更したファイルを書く。仕様は docs/DESIGN.md の次の行（今回追記済み）。

- §9 Adapter の「Codex の JSON-RPC の要求は…」「interrupt してから…」
- §11 配送ルールの「Agent の起動中に届いた配送は…」「再送の envelope には…」
- §11 配送ルールの「配送の途中で例外が出たら…」

## A. Codex の JSON-RPC に timeout がない

現状: `src/agents/codex-adapter.ts` の `request` は、応答が無ければ `pending` に永久に残る。handshake（`initialize`・`thread/start`・`thread/resume`）で Codex が応答しないと `start` が永久に解決せず、その Agent の mailbox の drain が止まる。

変更:
- `request` に timeout を付ける（`CODEX_REQUEST_TIMEOUT_MS = 120_000`）。過ぎたら `pending` から消して、method 名を含むエラーで reject する。応答が来たら timer を消す
- プロセスの終了時に残っている `pending` は、今の扱い（あれば）を変えない。無ければ reject する
- テスト: fake の process が応答しないとき、timeout（テストでは fake timer）で `request` を使う処理（例: `start`）が reject し、プロセスが kill される

## B. interrupt が効かないとターンが終わらない

現状: Claude は interrupt の control_request を送るだけ、Codex は `turn/interrupt` の応答を待つだけで、CLI が応答しないと Agent は busy のまま止まらない。`/interrupt` の HTTP リクエストも返らない（Codex）。

変更:
- `src/agents/base-agent-adapter.ts` に、interrupt を送ったときに timer をかける仕組みを足す（`INTERRUPT_TIMEOUT_MS = 30_000`）。ターンが終わったら（`finishTurn`）timer を消す。過ぎてもターンが終わっていなければ、既存の `abort("<id>: interrupt timed out")` でプロセスを止める（ターンはプロセスの終了後に failed で終わり、次の送信で session を resume して起動し直す。§9 の abort と同じ）
- Claude・Codex の `interrupt` はどちらもこれを使う。Codex は `turn/interrupt` の応答を待つ前に timer をかける。turn ID が未確定で interrupt を保留したときもかける
- Codex の `interrupt` の `request` が A の timeout で reject しても、例外を呼び出し元に返さず `error` event にする（`setTurnId` の中の扱いと同じ）。timer は B のものが働く
- テスト: interrupt 後にターンが終わらないと、30 秒（fake timer）で abort され、ターンが failed で終わる。期限内にターンが終われば abort されない

## C. 起動中の Agent への配送が失敗する

現状: `src/coordinator/agent-mailbox.ts` の `ensureRunning` は `status !== "stopped"` ならすぐ return する。`starting` のときも待たずに送るので、adapter の `beginTurn` が `<id> is starting` で reject し、人の入力が failed になる。`Workspace.init` の `coordinator.start()` と、復旧した入力の drain が重なると起きる。

変更:
- mailbox が起動中の Promise を持ち、`ensureRunning` が並行に呼ばれたらそれを共有する。起動に失敗したら Promise を消し、次の呼び出しで起動し直す（今の「失敗したら次の試行でも選んだ session を使う」は保つ）
- adapter が mailbox の外で起動された場合（無いはずだが）に備えて、`starting` のときに起動中の Promise が無ければ今どおり return してよい
- テスト: `ensureRunning` を 2 回並行に呼ぶと `start` は 1 回だけ。起動の完了前に enqueue した入力は、起動の完了後に送られて failed にならない

## D. 投げっぱなしの Promise の失敗が消える

現状:
- `src/coordinator/coordinator.ts` の `void this.deliver(...)`（restore・receiveMessage・autoResult など）と `void ...enqueue(...)`・`void this.sendToAgent(...)` は、reject するとログに `unhandledRejection` として残るだけで、送信元にも人にも伝わらない。`deliver` の中の `steer` は Claude で `proc.write` が throw しうる
- `src/mcp/server.ts:90` の `void handle(req, res)` は reject すると応答を返さず、Agent の tool call が timeout まで待つ

変更:
- Coordinator に、待たない Promise を走らせる private な関数を 1 つ作り（例: `detach(promise)`）、上の `void` をすべてそれにする。reject したら、その Agent の `error` event（`{ kind: "agent", agent, event: { type: "error", message } }`）を publish する。agent が決まらない箇所は `notice` にする
- `deliver` の中で例外が出たら、ターンの失敗と同じ扱いにする（作業を頼む message なら既存の再送、それ以外や 2 回目は既存の `notice.handoffFailed` と送信元への fallback）。`deliver` の構造上無理なら、上の `detach` での報告だけでよい（RESULT にどちらにしたか書く）
- MCP の `handle` が reject したら、応答をまだ書いていなければ 500 を返して閉じる
- テスト: steer（または送信）が throw したときに error event が出る。MCP の handler が throw したとき 500 が返る

## E. 再送に「再送である」印がない

現状: 作業を頼む message のターンが failed になると、30 秒後に同じ envelope をそのまま積み直す（`coordinator.ts` の `deliver(message, attempt + 1)`）。途中まで実装して失敗した DELEGATE が最初からやり直され、二重の作業になり得る。

変更:
- 再送（`attempt > 0`）の配送では、envelope の本文の前に 1 行添える（Agent 向けなので英語。定数にする）: `[Clodex] Retry: your previous attempt at this message failed partway. Check the current state of the files before continuing; do not redo finished work.`
- 添え方は既存の配送時の添え書き（`deliveryNote` など）に合わせる
- テスト: 1 回目の失敗後の再送の本文に、この行が入る。1 回目には入らない

## 変更してよいファイル

- `src/agents/base-agent-adapter.ts`、`src/agents/claude-adapter.ts`、`src/agents/codex-adapter.ts` と、それぞれのテスト
- `src/coordinator/agent-mailbox.ts`、`src/coordinator/coordinator.ts` と、それぞれのテスト
- `src/mcp/server.ts`、`src/mcp/server.test.ts`
- `src/i18n/messages.ts`（文言を足すときだけ）

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
