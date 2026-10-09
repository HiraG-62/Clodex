# CONVERSATION-DRAFTS: 入力欄の下書きを会話ごとに分ける

会話やプロジェクトを切り替えても、入力欄の書きかけがそのまま残って切り替え先に持ち越される。下書きを会話ごとに持ち、切り替えたら入れ替える。仕様の正は `docs/DESIGN.md` §28 の「入力:」。

## 変更

1. **下書きの扱いを純粋な関数にする**（例: `src/web/client/drafts.ts`。client に埋め込むので外部を参照しない関数にする。既存の `compose-input.ts` などと同じ作り）
   - 鍵: `clodex.draft:<project root>:<会話 ID>`（`encodeURIComponent` などで区切りと衝突しないようにする）
   - 例: `draftKey(projectRoot, conversationId)`、`staleDraftKeys(keys, projectRoot, conversationIds)`（今のプロジェクトの下書きのうち一覧に無い会話の鍵を返す。ほかのプロジェクトの鍵は返さない）
2. **client**（`src/web/client/client-main.ts`）
   - 今の会話の鍵（`state.projects` の current の `projectRoot` と、`state.conversations` の current の `id`）を覚えておく
   - state を受け取って鍵が変わったら: 前の鍵に今の入力欄の本文を保存（空なら消す）→ 新しい鍵の下書きを入力欄に入れる（無ければ空）→ 入力欄の高さ・強調表示・候補などを今の入力時と同じ処理で更新する（`onInputChanged` 相当）
   - 入力のたびに今の鍵へ保存する（空なら消す）。打つたびの保存が重ければ少し間を置いてよい
   - 送信して入力欄を空にしたら、その鍵の下書きも消す
   - 送信待ちの「編集」で本文を入力欄に戻したときも、その会話の下書きとして保存される（入力の保存の流れに乗れば足りる）
   - 会話の一覧を受け取ったら、今のプロジェクトの下書きのうち一覧に無い会話のものを消す
   - プロジェクトが無い（未選択）・会話が無いときは鍵を持たず、保存しない
   - 送り先の切り替え（Claude / Codex）は今のまま（下書きには含めない）
3. 文言は足さない

## テスト方針

- 下書きの関数のテスト（`drafts.test.ts`）: 鍵の作り方（区切りの衝突）、`staleDraftKeys` が今のプロジェクトの一覧に無いものだけを返す、ほかのプロジェクトの鍵は返さない
- `web-page.test.ts`: client に関数が埋め込まれていること（既存の形に合わせる）
- 画面は Playwright で確かめる。ビルド版の Hub はリポジトリの外に置く: `pnpm exec tsc -p tsconfig.build.json --outDir <%TEMP% のフォルダ>\dist`、そのフォルダに `package.json` を写し、`node_modules` へのジャンクション（`New-Item -ItemType Junction`）を置く。`CLODEX_HOME=<空の一時フォルダ>`（`.clodex/config.json` に別ポート）で `serve` する。空のホームではプロジェクトが無いので、一時フォルダに git の空のリポジトリを 1 つ作って `/project` で開き、`/new` で会話を 2 つにして切り替える（Agent は送信しない限り起動しない）
  - 会話 A で打つ → 会話 B に切り替えると空 → A に戻すと元の本文。読み込み直しても残る
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する。一時ファイルはリポジトリの外に置く
