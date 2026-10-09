# LOCAL-TIME-AND-LATEST: read_conversation の時刻を端末の時間帯にする・最新へ跳ぶボタン

2 つの独立した変更。触るファイルが重ならないので、コミットは分ける（コミットは claude が行う）。仕様の正は `docs/DESIGN.md` §12「会話本文の参照（`read_conversation`）」と §17 の「読み返している間に新しい項目が来ても」の項。

## 1. read_conversation の時刻

- Agent が `read_conversation` の UTC の時刻（`2026-10-09T13:13:38.874Z`）をそのまま人に伝え、画面の時刻（日本時間 22:13）と 9 時間食い違った
- `read_conversation` が返す各本文の `at` を、Hub のある端末の時間帯のオフセット付き ISO 8601（`2026-10-09T22:13:38+09:00`。秒まで。ミリ秒は無くてよい）にする。変換は返す直前に行い、保存（transcript の JSONL）は今どおり UTC
- 変換は純粋な関数にする（例: `toLocalIso(iso: string, offsetMinutes?: number): string`。テストで時間帯を渡せるように。既定は `new Date(iso).getTimezoneOffset()`）。置き場所は `src/project/conversation-transcript.ts` か小さな新しいファイル
- 対象: `src/mcp/server.ts` の `read_conversation` が返す `ConversationPage` の `entries[].at`

## 2. 最新へ跳ぶボタン

- 今は読み返している間に新しい項目が来たときだけ、文字の「新着 ↓」ボタン（`#newer`、`web.newer`）を出している。これを次のようにする（`src/web/client/client-main.ts`、`src/web/web-page.ts`、`src/i18n/messages.ts`）
  - 一番下にいない（`nearBottom()` でない）間は、新しい項目が来たかに関係なく出す。一番下に戻ったら隠す
  - 文字は出さず、下矢印のアイコン（既存の `arrow-down` などのアイコン）だけ。`aria-label` と title は ja「最新へ」/ en "Latest"（`web.newer` を書き換えてよい）
  - 読み返している間に新しい項目が来たら、ボタンに小さな点（アクセントの色の丸）を付ける。一番下に戻ったら消す
  - 置き場所はログの右下（今の中央下から変える）。丸いアイコンボタン。入力欄や質問欄と重ならないこと。スマホでも押しやすい大きさ（タップ領域 44px）
  - 押すと今どおり一番下へスクロールする
- スクロールのたびに出し入れの判定をする（今の scroll の処理に足す）

## テスト方針

- 1: `toLocalIso` のテスト（+09:00、-05:00、0 の時間帯。日付をまたぐ）。`read_conversation` の結果の `at` がオフセット付きになること（`mcp/server.test.ts` か transcript のテスト）
- 2: 出す・隠す・点の判定を純粋な関数に切り出せるならテストする。見た目は CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、読み返している状態（ボタンあり）と新しい項目が来た状態（点あり）のスクリーンショットを PC とスマホで撮り、RESULT に path を書く
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
