# TARGET-PER-CONVERSATION: 送り先を会話ごとに記憶する

Web UI で会話を切り替えると送り先が primary（通常 Claude）に戻る。直前までその会話で使っていた Agent を保つ。仕様の正は `docs/DESIGN.md` §8（更新済み）。

## Fixed

- 送り先（`ctx.store.target`）を会話ごとに localStorage へ保存し、会話の切り替え・ページの再読み込みでその会話の値に戻す
  - キーは下書き（`src/web/client/drafts.ts`）と同じ流儀で project + 会話 ID から作る（例: `clodex.target:<project>:<conversationId>`）
  - 保存のタイミングは送り先の切り替え時（composer のボタン・トグル）
  - 復元の値が今の `AGENT_IDS` に無ければ捨てて primary に戻す
- 値が無い会話では今までどおり primary を使う
- solo で送り先が固定されている会話では solo が優先（既存の挙動のまま。固定中に保存値を上書きしない）
- 会話の削除で残った鍵は下書きの掃除（`staleDraftKeys` の流儀）と同様に消す
- テスト: 切り替えで戻る・値なしで primary・不正値を捨てる・掃除。既存の client テストの流儀で

## Discretion

- 実装位置（drafts.ts に相乗りするか専用モジュールか）、鍵の正確な形
- store への持たせ方

## 編集してよいファイル

- `src/web/client/`（composer.ts・drafts.ts・conversation-tabs ほか必要な範囲）と各テスト
