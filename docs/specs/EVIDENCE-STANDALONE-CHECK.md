# EVIDENCE-STANDALONE-CHECK: 証跡の検査は単独で実行したものだけ終了コードを記録する

## 背景

`src/coordinator/work-baseline.ts` の `record` は、コマンドの文字列に検査のコマンド（`verify.implement`）が含まれる tool の呼び出しを、後のもので上書きして記録している。Codex は `pnpm run check:anim 2>&1 | grep -E "error|fail"` のようにパイプでつないで実行することがあり、このときの終了コードは `grep` のもの（当たりが無いと 1）。検査は合格なのに、証跡には `exit 1` と出た（roguelike、10/22 の群勢の撤去の RESULT）。

仕様の正は `docs/DESIGN.md` §13「検証の証跡」の `checks` の項（claude が更新済み。触らない）。

## Fixed

- 検査の実行を 2 種類に分ける
  - **単独の実行**: コマンドから、先頭の `cd <path>;` / `cd <path> &&`（繰り返しあり）と、外側のシェルの包みを除いた残りが、検査のコマンドで始まり、その後ろに `|`・`;`・`&&`・`||` を含まない（引数や `2>&1`・`> file` のリダイレクトは付いてよい）
    - シェルの包み: `pwsh` / `pwsh.exe` / `powershell` / `powershell.exe`（フルパス・引用符付きを含む）の `-Command '…'` / `-Command "…"`、`bash` / `sh` の `-c` / `-lc '…'`。実データの例: `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'pnpm run check:anim'`
  - **つないだ実行**: 検査のコマンドを含むが、単独の実行ではないもの
- 記録
  - 単独の実行は今どおり、最後のものの `exitCode`（`tool_end` で更新）・`failed` を記録する
  - つないだ実行は、その検査に単独の実行がまだ無いときだけ `ran: true` を記録し、終了コード・失敗の印は付けない（`tool_end` の値も入れない）。単独の実行が一度でもあれば、つないだ実行で上書きしない
- 表示（envelope の `Evidence (recorded by Clodex):` の行、Web UI・TUI の証跡）: `ran: true` で終了コードも失敗の印も無い検査は「結果不明」と分かる表示にする（envelope は英語で `pnpm run check:anim: exit unknown` のように。Web UI・TUI は i18n の文言を足す。警告色にはしない）。今の表示がすでにそうなっていれば変えない
- 定型文（`src/context/role-instructions.ts`）の `Default checks:` の行の末尾に `Run each check as its own command without pipes or chaining so Clodex can record its exit code.` を足す

### 編集してよいファイル
- `src/coordinator/work-baseline.ts`、`src/coordinator/work-baseline.test.ts`
- 証跡の表示: `src/coordinator/` の envelope の組み立て、`src/web/client/`、`src/tui/` の証跡の描画と、その test
- `src/context/role-instructions.ts`、`src/context/role-instructions.test.ts`
- `src/i18n/messages.ts`

## Discretion
- 単独の実行の判定の実装（純関数にしてテストする）
- 表示の文言の細部
- テストの粒度。最低限、次を確かめる
  - `pnpm run check:anim`、`cd /e/dev/x; pnpm run check:anim`、上の pwsh の包み、`pnpm run check:anim 2>&1` は単独
  - `pnpm run check:anim 2>&1 | grep -E "x"`、`sed -i ...; pnpm run check:anim`、`pnpm run check:anim && echo ok` はつないだ実行
  - 単独の合格（0）の後のパイプの実行（1）で、証跡が 0 のまま
  - パイプの実行だけなら `ran: true` で終了コードなし、表示は結果不明

## 完了の条件
- `pnpm test`・`pnpm typecheck`・`pnpm lint` が通る
- RESULT に、実行したコマンドと結果、変えたファイルの一覧を書く
