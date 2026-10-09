# MESSAGE-IN-TURN: Agent が送った message をそのターンの枠にまとめる

Agent が依頼すると、ログに「依頼しました」の最終応答のターンの枠と、「Claude → Codex DELEGATE」の message の行の 2 つが並ぶ。RESULT も「実装しました」の最終応答と RESULT の行が並ぶ。message をそのターンの枠の本文にして、1 つにまとめる。仕様の正は `docs/DESIGN.md` §17 ログの「Agent がターンの中で formal message を送ったら」の項。

## 変更

1. **timeline**（`src/web/client/timeline.ts`）
   - turn の項目に `messages?: Array<{ message: AgentMessage; envelope?: string }>` を足す
   - `applyFeedItem` で `message` event（`ACK` は今も出ていないはずだが、来たら今どおり）を受けたら:
     - 送信元（`message.from`）の作業中のターンがあれば、そのターンの `messages` に足し、別の項目は作らない
     - `message.auto` なら、送信元の最後のターン（作業中でなくてよい。直前に終わったもの）に足す
     - どちらも無ければ今どおり `kind: "message"` の項目
   - 最終応答を末尾の別の項目に出す処理（`resultId` / `processId`）では、`messages` は最終応答の項目の方へ移す（本文になるのは最終応答の項目のため）
   - 「後ろに別の項目が並んだか」の判定（`ownItem`）は、message が枠に入るので自然に要らなくなる部分がある。今のテストが通るように整理する
2. **描画**（`src/web/client/client-main.ts` の turn の描画）
   - `messages` があれば、枠の本文は message のカードを送った順に並べる（今の message の項目の描画を関数に分けて使い回す。送信元 → 宛先・種類・taskId・本文・spec・関連ファイル・指摘・相手に渡した全文（畳む）・自動の印）
   - 最終応答は本文に出さず、畳んである「作業」の最後に発言として出す
   - 画像のプレビュー（`appendImagePreviews`）は message の本文にも今どおり付ける
3. **ほかの集計**
   - 成果物の一覧（`collectArtifacts`）など、`kind: "message"` の項目を見ているところは、turn の `messages` も見るようにする
   - 作業ログ（`workingFeed`）は今のまま
4. TUI（`src/tui/`）は今のまま

## テスト方針

- `timeline.test.ts`
  - 作業中のターンに自分の message が届くと、別の項目にならず `messages` に入る。複数なら順に
  - 自動の RESULT は直前に終わった送信元のターンに入る
  - 送信元の作業中のターンが無い message は今どおり別の項目
  - 最終応答を末尾に出す場合、`messages` は最終応答の項目に移る
  - `rebuildTimeline`（履歴の読み込み）でも同じ結果になる
- `artifacts.test.ts`（あれば）: turn の `messages` の本文の画像のパスも拾う
- 画面の確認は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で行う。DELEGATE を送ったターンが 1 つの枠になり、最終応答が「作業」の中に入っていることのスクリーンショットを RESULT に書く（state や feed を差し込んで再現してよい）
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
