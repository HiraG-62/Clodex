# DELIVERY-FIXES: 配送の精度の穴を塞ぐ（spec 差分・auto RESULT・read_conversation の ID・Codex の effort）

4 つの小さな修正をまとめて行う。どれも Coordinator の配送と envelope の周り。仕様の正は `docs/DESIGN.md` の次の箇所。

- §13「Spec の差分」（配送直前の計算・session の確認・`specHash`）
- §11 Message Schema の `effort`・`specHash`
- §12 配送ルールの auto `RESULT` の `status`
- §12「会話本文の参照（`read_conversation`）」の `id`
- §9 Model / Effort の「Codex には毎ターン effort を明示して送る」

## 変更

対象のファイルは目安。同じ目的に要るファイルは確認せずに触ってよい。

### 1. spec の差分を配送の直前に計算する（`src/coordinator/coordinator.ts`・`agent-mailbox.ts`・`src/context/context-resolver.ts`）

- 今は `accept` で `specChanges` を計算し（`specSnapshots`、`coordinator.ts` の 690 行付近）、`deliver` で envelope を作ってから mailbox に積んでいる。これを、mailbox が項目を送り始める直前（と、実行中のターンに足す `steer` の直前）に envelope を作る形に変える（例: mailbox に envelope の文字列ではなく、配送時に呼ぶ関数を渡す）
- 配送時に設計書を読み、記録 `{ content, sessionId }`（キーは宛先 + 実パス）と比べる。記録の `sessionId` が宛先 Agent の今の `sessionId` と同じときだけ `specChanges` を付ける。違う・記録が無いなら付けない。配送したら記録を更新する
  - `fresh` の配送は session を新しくしてから送るので、新しい session ID で比べる（＝前の記録とは一致せず、差分を付けない）
  - 取り消された配送待ち（`/cancel`、CANCEL）は配送していないので記録しない
  - 設計書が配送時に読めなくなっていたら、`specChanges` も `specHash` も付けずに送る（受理時の存在確認は今どおり）
- `specHash`: 配送した中身の SHA-256 の先頭 12 桁を message に付け、envelope の `Spec:` 行に `(sha256:<hash>)` を添える（`specChanges` の表示と併記）。`RESULT` / `ANSWER` の `spec` も同じ
- 再送（`attempt > 1`）も配送のたびに計算し直す
- 画面に出す message（Event Bus の `message`）は受理時のままでよい（`specChanges`・`specHash` は envelope だけで使う）

### 2. auto RESULT に `status` を付けない（`coordinator.ts` の `autoReply`）

- `...(answer ? {} : { status: "done" as const })` を消す

### 3. `read_conversation` が message の ID を返す（`src/project/conversation-transcript.ts`）

- `page()` は今 `entries.slice(...).map(({ id: _id, ...entry }) => entry)` で ID を落としている。formal message の entry には message の ID（`msg_…`）を `id` として返す。ほかの種類（入力・最終応答・質問）は今どおり返さない
- 保存している entry の `id` が message の ID と別物なら、保存時に message の ID を持たせる（既存の保存済みの行に無ければ返さないだけでよい）
- MCP の tool の説明（`src/mcp/`）に、message には `id` が付くことを短く足す

### 4. send_message の `effort` と、Codex に毎ターン effort を送る（`src/protocol/messages.ts`・`src/agents/codex-adapter.ts`・`coordinator.ts`・`agent-mailbox.ts`）

- `sendMessageShape` に `effort?: string`（describe は英語で短く: "Reasoning effort for the turn that handles this request (codex only)"）。`DELEGATE` / `REVIEW_REQUEST` のみ、`to` が `codex` のときだけ受け付ける。ほかは拒否（エラー文は既存の形に合わせる）。値は今の `/effort` の Codex の検査と同じ（model ごとに違うので、今の実装の検査をそのまま使う。無ければ空でない文字列）
- Codex adapter: `send` の options に effort の上書きを受け取れるようにし、`turn/start` に毎回 `effort` を付ける。上書きが無ければ、人が `/effort` で決めた値、それも無ければ thread の開始時に読んだ既定の値（今の `this.effort ??= response.reasoningEffort`）。上書きは adapter の `this.effort`（`/status` に出る値）を変えない
- Coordinator / mailbox: `effort` 付きの message の配送で、その値を adapter に渡す。割り込み（`steer`）でターンに足すときは effort を変えられないので無視する
- envelope に `Effort: <value>` を足す（受け手が分かるように）

## テスト方針

- spec の差分: 同じ session への 2 回目の配送で差分が付く。`fresh`・`/new` の後、記録が無い（Hub の再起動に相当）ときは付かない。配送待ちの取り消しの後、次の配送は前回の配送と比べる（取り消した版と比べない）。受理と配送の間に設計書を書き換えたら、配送時の中身で比べ、`specHash` もその中身になる
- auto RESULT に `status` が無い
- `read_conversation` の formal message に `id` が付き、ほかには付かない
- `effort`: Codex への DELEGATE で `turn/start` にその値。次のターンは元の値に戻る。人の入力のターンにも毎回 effort が付く。Claude 宛と FIX などは拒否
- fake adapter の評価ケースとして、上の spec の差分の 3 つ（fresh 後・取り消し後・複数 chain が交互に配送されるとき）を `coordinator.test.ts` に入れる
- 最後に `pnpm test`・`pnpm typecheck`・`pnpm lint` を 1 回ずつ。コミットはしない

## 触ってよいファイル

- `src/coordinator/**`、`src/context/context-resolver.ts`、`src/protocol/messages.ts`、`src/project/conversation-transcript.ts`、`src/mcp/**`、`src/agents/agent-adapter.ts`・`codex-adapter.ts`・`claude-adapter.ts`（型の追従）、`src/hub/**`（型の追従）とそれぞれのテスト
- 生成コマンドが書き換えるファイル
- `docs/DESIGN.md` は触らない（矛盾を見つけたら QUESTION）
