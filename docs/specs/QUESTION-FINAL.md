# QUESTION-FINAL: 質問の付いた枠の最終応答を本文に出す

## 背景

Agent は `ask_user` で質問を出した後の最終応答に、選択肢を比べるための案の中身（表を含む長文）を書くことが多い。今の画面は、質問・message の付いた枠の最終応答を畳んだ「作業」に移すので、案の中身が見えず答えられない。

実例（roguelike の feed、seq 14888〜14893）: `tell_user` → `ask_user`（question）→ `text`（案の全文）→ `turn`（同じ全文）。質問で枠が区切られ、続きの枠に作業が無いままターンが終わるので、`timeline.ts` の `turn` の処理が最終応答を前の枠の `steps` の最後（畳んだ「作業」）に入れている。

仕様の正は `docs/DESIGN.md` §17「画面」のログの節の「人への質問（`ask_user`）も…」の項（claude が更新済み。触らない）。

## Fixed

- 質問（`questions`）の付いた枠の最終応答は、畳んだ「作業」に移さず、本文として**質問のカードの上**に出す（Markdown。長さで切らない。成果物の画像のプレビューも今の最終応答の本文と同じ）
  - 質問と message の両方が付いた枠も同じ
  - message だけの枠は今どおり（最終応答は「作業」の最後）
  - `tells` だけの枠は TELL-USER-GROUP の今の扱い（発言の後に本文）のまま
- 質問で区切った後の続きの枠に作業が無いままターンが終わったとき（`timeline.ts` の `turn` の処理で、最終応答を前の枠に入れているところ）、前の枠に質問があれば、最終応答を前の枠の `steps` ではなく、前の枠の最終応答（`text`）として入れる。前の枠が message だけなら今どおり `steps`
- 最終応答と同じ内容の say を `steps` から外す今の重複除去は保つ（案の全文が「作業」と本文に二重に出ないこと）
- Web UI（`src/web/client/log-item.ts`）と TUI（`src/tui/terminal-layout.ts`）の両方
- 保存する feed・event は変えない（読み込み直せば既存の会話も新しい表示になる）

### 編集してよいファイル
- `src/web/client/timeline.ts`、`src/web/client/timeline.test.ts`
- `src/web/client/log-item.ts`、`src/web/client/log-item.test.ts`、`src/web/client/style.css`
- `src/web/client/log-diff.ts` とその test（差分描画で必要なら）
- `src/web/client/artifacts.ts` とその test（成果物の一覧の数え方が変わるなら）
- `src/tui/terminal-layout.ts`、`src/tui/terminal-layout.test.ts`

## Discretion
- 実装の形
- テストの粒度。最低限、次を確かめる
  - 上の実例の event 列（tell → question → text → turn）で、最終応答が質問の枠の本文（質問のカードの上）に出て、「作業」に入らない
  - 質問の後に作業（tool）が続いてからターンが終わる場合は、続きの枠の本文に出る（今どおり）
  - message だけの枠の最終応答は今どおり「作業」に入る

## 完了の条件
- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く
