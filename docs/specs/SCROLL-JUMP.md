# SCROLL-JUMP: Web UI のログが勝手にかなり上まで飛ぶ

人の報告: 「たまに、いきなりかなり上のチャットまで勝手に飛ぶ」。PC とスマホのどちらで起きるか、操作の有無は不明。原因を調べて直す。仕様の正は `docs/DESIGN.md` §17 ログ（作業中の枠は一番下、ターンが終わったら末尾に固定、区切り）と、最新まで飛ぶボタン・一番下に張り付く挙動。

## 調べること

対象のファイルは目安（`src/web/client/log-view.ts`・`log-item.ts`・`timeline.ts`・`client-main.ts`・`style.css` など）。同じ目的に要るファイルは確認せずに触ってよい。

- スクロールの位置を変えうる箇所を洗い出す: `scrollToBottom`・`nearBottom`・`stick` の判定、`renderLog(force)` の全描画（`replaceChildren` などで高さが一度 0 になる・`scrollTop` が保たれない）、作業中の枠を一番下へ動かす・区切った枠を固定する処理、画像のサムネイルの読み込み（高さが後から変わる）、`details` の開閉、`reset` event、state の更新ごとの再描画、タブ・会話の切り替え、スマホのキーボード（`visualViewport`）、`scrollIntoView`・`focus()`（`preventScroll` の無いもの）
- 一番下に張り付いていないとき（過去を読んでいるとき）に、新しい event・state の更新・画像の読み込みで、見ている位置がずれないか。張り付いているときに、全描画で一瞬上に飛んでから戻らない、ということが無いか
- 再現: CLAUDE.md / AGENTS.md の「画面の確認（Web UI）」の手順で、長い会話（実データの feed を写してよい。`*.recovery.json` は写さない）を開き、Playwright で feed の event を流し込みながら（作業中の枠の更新・ターンの終わり・message・画像付きの本文・state の更新）、途中まで遡った位置と一番下にいる位置のそれぞれで `scrollTop` の変化を記録する。PC とモバイルの emulation の両方で

## 直し方

- 原因が分かったら、その箇所を直す。表示中の項目を基準に位置を保つ（全描画の前に、見えている先頭の項目と、その項目のずれを覚えて戻す）などは、原因に応じて選ぶ
- 再現できなかった場合も、上で見つけた危うい箇所（位置を保たない全描画・`preventScroll` の無い focus など）を直し、何を直したかを RESULT に書く

## テスト方針

- 位置を決める純粋な関数を作るなら、それをテストする（例: 描画の前後の項目の位置から、戻す `scrollTop` を求める）
- 直す前に再現できたら、直した後に同じ手順で飛ばないことを確かめ、記録（`scrollTop` の推移）を RESULT に書く
- `pnpm test`・`pnpm typecheck`・`pnpm lint`。コミットはしない。終わったら `send_message` の RESULT で報告する
