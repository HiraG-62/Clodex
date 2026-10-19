# TELL-USER-GROUP: 同じターンの tell_user の発言を 1 つの枠にまとめる

## 背景

`tell_user`（TELL-USER）の発言は、formal message・質問と同じく `attachToTurn(..., split: true)` で作業中の枠を区切っている（`src/web/client/timeline.ts`）。長い作業で Codex が数分おきに報告すると、報告のたびに見出し（Agent 名・時刻）と「作業 N 件」の付いた枠が増え、ログが散らかる。

仕様の正は `docs/DESIGN.md` §17「画面」のログの節の「人への発言（§12 `tell_user`）も…」の項（claude が更新済み。触らない）。

## Fixed

- `tell` event はターンの枠を区切らない（`attachToTurn` の `split: false` 相当）。同じターンの発言は 1 つの枠の `tells` に送った順に入る
  - 作業中の枠が区切り済みの続きの枠（`continuation`）なら、その続きの枠に入る（今の作業中の枠に足すだけ）
  - 送ったターンが無いときに単独の項目として並べる扱いは今どおり
- formal message・質問は今どおり枠を区切る。区切った時点までの発言は区切った枠に残る
- 最終応答: 枠の添付が `tells` だけ（`messages`・`questions` が無い）なら、最終応答（`text`）は畳んだ「作業」に移さず、本文の発言の後に出す。今の重複除去（最後の say が最終応答と同じなら steps から外す、など）は変えない
  - Web UI（`src/web/client/log-item.ts` の `finalStep` と本文）と TUI（`src/tui/terminal-layout.ts` の turn の分岐）の両方
  - 区切った後の続きの枠に作業が無いままターンが終わったとき、最終応答を前の枠の「作業」に入れる今の扱い（`timeline.ts` の `turn` の処理）は、前の枠に message・質問があるときの扱いなので変えない。続きの枠に `tells` があれば、続きの枠は作業ありとして扱う（最終応答はその枠の本文に出る）
- 見た目: 同じ枠の発言の間に区切り線を入れない。段落の間隔だけで分ける（今の Markdown の本文と同じ見た目）。発言ごとの見出し・時刻は出さない
- 保存する feed・event は変えない（表示の組み立てだけ。既存の会話を読み込み直しても新しいまとめ方で出る）

### 編集してよいファイル
- `src/web/client/timeline.ts`、`src/web/client/timeline.test.ts`
- `src/web/client/log-item.ts`、`src/web/client/log-item.test.ts`、`src/web/client/style.css`
- `src/web/client/log-diff.ts` とその test（差分描画で必要なら）
- `src/tui/terminal-layout.ts`、`src/tui/terminal-layout.test.ts`

## Discretion
- 実装の形（`attachToTurn` の引数で分けるか、`tell` 専用の分岐にするか）
- テストの粒度。最低限、次を確かめる
  - 作業中に `tell` を 3 回送ると、枠は 1 つで `tells` が 3 件（間に tool・text が挟まっても同じ）
  - `tell` → message の順なら、message で区切られ、`tell` は区切った枠に残る
  - 添付が `tells` だけのターンが完了すると、最終応答は本文に出て、「作業」に入らない（Web・TUI）
  - message が付いた枠の最終応答の扱いは今どおり

## 完了の条件
- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く（画面の撮影は claude が行う）
