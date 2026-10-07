# UI-REVAMP 段階 2 のレビュー指摘の修正

対象は e0acc7f（行番号はその時点）。修正の方法は任せる。仮ターンと適用待ちは、`timeline.ts` / `pending.ts` の純粋関数のテストを先に書く。

## high

1. **設定の適用待ちが永遠に残る**（`client-main.ts:196-208`、`:1080`、`pending.ts:6-22`）
   - サーバーは拒否・失敗でも 204 を返すので、pending を外す経路がない。選択肢も押せないまま
   - 再現: sandbox が on の project で権限を選ぶ（shell は拒否のメッセージを出すだけ）/ `/model`・`/effort` の設定ターンが failed / 別のクライアントが別の値に変える
   - 修正案: 送った時点の state の値を記録し、HTTP 完了後の最初の state で値が変わっていなければ外す（または期限を付ける）
2. **送信待ちを取り消す・編集すると「起動中…」が残る**（`timeline.ts:29-33`）
   - busy の Agent へ送ると human event はすぐ出る。取り消しでは turn も error も来ない
   - 修正案: `withStartingTurns` に `pendingInputs` を渡し、配送待ちがあるか busy の Agent には仮ターンを出さない

## medium

3. busy の Agent への送信待ちの間も「起動中…」が出る（2 と同じ修正）
4. 版の更新の帯が、直後の state の `conn.hidden = true` で数 ms で消える（`client-main.ts:1474-1478`、`:1505`）。`reloading` フラグで以降の onmessage を無視する
5. ファイル候補の読み込み中に、見えない `suggestion` が Enter / Tab で確定する。`@agent` の候補も隠れる（`:1239`、`:1358`）
6. 中断が効かず busy が続くと、中断ボタンが押せないまま（`:1500` 付近）。HTTP 完了から 5 秒で再び押せるようにする

## low

7. スマホの Agent シートで、中断の完了後に `setPending(false)` が `wasDisabled` で上書きし、idle なのに中断が押せる（`:154`、`:698`）
8. `!command` の経過時間が、出力の `error: ` 行や並行実行の別の `exit` で消える（`pending.ts:31-32`）
9. `/api/files` の失敗時に `filesLoadedAt` を更新せず、`@` を含む入力のたびに取り直す（`:1282`）
10. 履歴を遡っている間、state のたびの `renderLog()` で項目が増えなくても「新着」が出る（`:1509`）
11. 再接続で `opened` を消さなくなった。Hub の再起動で seq が振り直されると、別の項目に開閉状態が当たる（`:1460`）。version の受信時か commitReplay で clear

## 段階 3（16680ff）の見た目の差異

比較: `revamp-3-pc-dark.png`、`revamp-3-compare-drawer.png`、`revamp-3-compare-agent.png`

12. **PC の入力欄で、画像ボタンが送信ボタンの横ではなく欄の中央に出る**（段階 3 の退行。スマホ用の CSS が PC に効いている）
13. Agent ストリップ: model 名は省略しなくなった（ゲージ列 96px）が、ゲージの棒が 25px ほどしかなく読めない。model 名を省略せず、棒も 60px 以上にする（外枠の最大幅 1240px を広げる、ラベル「ctx / 5 時間 / 週」を短くするなど。方法は任せる）
14. 質問ごとの header（例「配置」）が古い `.kind` の箱のまま（同上）。小さな muted の見出し文字にする
15. スマホの Agent シートのゲージに reset 時刻が無い。DESIGN.md §17 のとおり、`21:05 31%`、`10/10 09:00 44%` のように値の側に出す
16. スマホのドロワー: 「新しい会話」は白黒反転ではなくモックどおり枠 + アイコンのボタン（文言は「新しい会話」）。下の project の選択は native の select のフルパスではなく、PC と同じ folder + 名前 + chevron の pill

## 元の挙動に戻すもの

- 名前の変更のプロンプトのキャンセル、削除の confirm の拒否で、シートを閉じる
- model の「その他」欄を、適用後に空にする
