# ORPHAN-JOB: Hub を Job Object に入れ、異常終了でも子孫のプロセスを残さない

仕様は docs/DESIGN.md §10 の「終了」（今回追記済み）。前提の実測は docs/spikes/orphan-processes.md（案 B を推奨）。

**手順 1 の実測が通ったときだけ手順 2 の実装に進む。** 通らなければ、実測の結果だけを記録して RESULT（status: failed）で報告する。

## 手順 1: 実測（spike の続き）

`spikes/orphan-probe.mjs`・`spikes/orphan-job.ps1` を拡張し、結果を `docs/spikes/orphan-processes.md` に節を足して記録する。

1. **handle の複製**: helper が `KILL_ON_JOB_CLOSE` の Job を作り、擬似 Hub（node）自身を `AssignProcessToJobObject` で登録し、`DuplicateHandle` で Job の handle を擬似 Hub のプロセスに複製して、自分の handle を閉じて終わる
   - helper が終わった後も、擬似 Hub と子が動き続けること（Job が閉じていないこと）
   - その後で擬似 Hub が起動した子・孫（PowerShell 経由の node を含む）が、擬似 Hub の `taskkill /PID <hub> /F`（`/T` なし）ですべて止まること。止まるまでの時間
   - 擬似 Hub の正常終了（`process.exit`）でも子孫が止まること（正常終了の経路では今どおり止めるので、二重に止めても問題が無いこと）
2. **起動の遅れ**: helper の起動から登録・複製の完了までの時間
3. **GUI からの起動**: Hub がすでに別の Job に入っている場合（前回の spike と同じ模擬）でも 1 が成り立つこと
4. sandbox（別ユーザーのプロセス。`Start-Process -Credential`）は、この PC に `clodex-agent` ユーザーが無いので実測しない。記録に「未実測」と書く

## 手順 2: 実装

- helper の順序は **`DuplicateHandle`（Hub へ handle を複製）→ `AssignProcessToJobObject`（Hub を登録）→ 自分の handle を閉じる**。先に登録すると、複製に失敗したとき helper が handle を閉じた時点で Hub ごと止まるため。複製の後で登録に失敗しても、Hub が空の Job の handle を持つだけで害はない

- `src/process/job-object.ts`（名前は任意）: Windows のときだけ、helper の PowerShell を起動して 1 の処理をさせ、完了（成功・失敗）を待つ関数。C# のソースは `src/sandbox/native-source.ts` と同じ方式で文字列として持つ。helper に渡すのは Hub の pid だけ
  - 失敗（PowerShell が無い・API が失敗・時間切れ）しても例外にせず、結果を返す。時間切れは定数（例: 10 秒）
  - Windows 以外では何もせず成功扱い
- `src/index.ts`: Hub として起動するとき（Hub に接続するだけの TUI のときは除く）、**子プロセスを 1 つも起動する前に**この関数を await する。起動時の model の一覧の取得（startup-probe）なども子プロセスなので、その前にする。失敗したら stderr に 1 行（文言は `src/i18n/messages.ts`。例:「Job Object の登録に失敗: {message}」）出して続ける
  - 起動の遅れを減らすため、子プロセスを起動しない準備（設定の読み込みなど）と並行に走らせてよい
- 正常終了の経路（今の `killProcessTree`）は変えない

## テスト

- `job-object.ts`: helper の起動を注入できる形にし、成功・失敗・時間切れ・Windows 以外の分岐をテストする（実際の PowerShell は起動しない）
- C# のソースが `Add-Type` でコンパイルできることは、手順 1 の実測で確かめたことを RESULT に書けばよい
- 実際の Hub（`pnpm dev serve`、一時の `CLODEX_HOME`。CLAUDE.md の「画面の確認」の手順）で、`!& node -e "setInterval(()=>{},1000)"` を起動してから Hub の node を `taskkill /PID <pid> /F` で止め、孫の node が残らないことを確かめて RESULT に書く。Agent にはターンを送らない

## 変更してよいファイル

- `spikes/orphan-*`、`docs/spikes/orphan-processes.md`、`docs/spikes/README.md`
- `src/process/job-object.ts`（新規）とそのテスト、`src/index.ts`、`src/i18n/messages.ts`

## 確認

- `pnpm test`、`pnpm typecheck` が通ること
