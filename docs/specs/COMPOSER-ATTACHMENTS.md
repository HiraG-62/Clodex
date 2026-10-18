# COMPOSER-ATTACHMENTS: 貼った画像を入力欄の中に縮小画像で並べ、× で外せるようにする

## 背景

今は Web UI で画像を貼り付け・選択すると、保存先のパスを `@<パス>` として入力欄の文字に足している（`src/web/client/composer.ts` の `attach` / `insertAtCaret`）。長いパスが文字として並び、何を添付したか見えず、外すにはパスを消す必要がある。Claude デスクトップのように、入力欄の枠の中・文字の上に縮小画像を並べ、右上の × で外せるようにする。

仕様の正は `docs/DESIGN.md` §28 i18n の直前の「画像の貼り付け」と、§17「待ちの表示」の「そのほか」の行。

## Fixed

### 振る舞い

- 貼り付け（`paste`）・ファイル選択（`#attach` / `#attach-file`）で画像を受けたら、`POST /api/upload` は今どおり。パスを入力欄の文字に入れず、composer の添付の一覧に足す
- 添付の一覧は `.box` の中、`textarea`（`.input-wrap`）の上に横に並べる（送信待ちの一覧 `#pending`・候補 `#suggest` の位置や挙動は変えない）。添付が 0 件なら領域ごと出さない（高さを取らない）
- 縮小画像: 角丸の正方形 64px（PC・スマホ共通）、`object-fit: cover`。右上に × のアイコンボタン（既存のアイコンの `<symbol>` を使う。無ければ足す。`aria-label` と title は i18n の「削除」/ "Remove"）。スマホでは × の押せる範囲を 44px にする（見た目は小さくてよい）
  - × を押すと一覧から外す。サーバーのファイルは消さない
  - 縮小画像を押すと、成果物と同じ lightbox（`artifacts-lightbox.ts`）でその画像を開く（保存が終わった添付だけ）
- 保存中: 貼った直後から `URL.createObjectURL` の画像で縮小画像を出し、上にスピナー（既存の `.spin`）を重ねる。保存中は送信ボタンを押せない（今の `ctx.store.uploading` の扱いを保つ）。保存中に × で外したら、保存が終わっても一覧に戻さない
  - 保存に失敗したら縮小画像を外し、今どおり `web.upload.failed` の toast を出す
  - object URL は外したとき・送信後に `revokeObjectURL` する
  - 会話・project を切り替えた（`liveGeneration` が変わった）後に保存が終わった添付は、今どおり今の会話には足さない
- `#upload-status`（入力欄の上の「アップロード中」のチップ）と、使われなくなる文言のキー（`web.upload.loading`）は消す
- 送信: 本文（trim 後）の末尾に、添付のパスを `@<パス>` として足す。本文と添付は改行 1 つで分け、添付どうしは空白 1 つで分ける。本文が空なら `@<パス>` だけ。添付が 1 件以上あれば本文が空でも送れる。`!command`（シェル入力）のときは添付を足さない（添付は残す）
  - 送信に成功したら、入力欄と同じく添付を空にする（送信の途中で会話を切り替えたときの扱いは今の入力欄の扱いに合わせる）
  - 送る文字列の組み立ては純関数にしてテストする
- 下書き: 添付のパスの配列を、会話ごとの下書き（`drafts.ts` の `draftKey`）と対になる端末の保存に JSON で持つ。会話の切り替え・読み込み直しで戻す。戻した添付の縮小画像は、保存先のパスのプレビュー（ログの画像のプレビューと同じ URL の作り方）を使う。古い会話の下書きの掃除（`staleDraftKeys`）の対象にも含める
- 送信待ちの入力の「編集」で入力欄に戻す本文は今どおり文字のまま（`@<パス>` を添付に戻さない）
- サーバー（`/api/upload`）・Agent への画像の渡し方・ログの人の入力の画像のプレビューは変えない
- `docs/DESIGN.md` は claude が更新済み。触らない

### 編集してよいファイル

- `src/web/client/` の下（`composer.ts`、`drafts.ts`、`connection.ts`、`store.ts`、`store-init.ts`、`artifacts-lightbox.ts` など）と、その test。新しいファイルを足してよい（例: `composer-attachments.ts`）
- `src/web/web-page.ts`（DOM と CSS。CSS が別ファイルならそのファイル）と、その test
- `src/i18n/messages.ts`（文言の追加・削除）
- `pnpm build` などの生成で書き換わるファイル

## Discretion

- 添付の状態を composer の中に持つか、`store` に持つか。モジュールの分け方
- 下書きの添付の保存キーの名前
- 縮小画像の並びの間隔・× の大きさなどの CSS の細部（DESIGN.md §17「部品」の質感・状態の決まりには従う: hover / 押下 / focus-visible、120ms の transition、`prefers-reduced-motion`）
- テストの粒度。最低限、次を確かめる
  - 送る文字列の組み立て（本文あり・本文なし・添付なし・シェル入力）
  - 添付があれば本文が空でも送れる／保存中は送れない
  - × で外す・保存中に外したら戻らない・失敗で外れる
  - 下書きの添付の保存と復元、古い会話の掃除

## 完了の条件

- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く（画面の撮影は claude が行う）
