# ORPHAN-SPIKE: Hub が異常終了したときに子プロセスを残さない方法の実測

製品のコードは変えない。`spikes/` で実測し、結果を `docs/spikes/orphan-processes.md` に記録して、`docs/spikes/README.md` の表に 1 行足す。実装は結果を見て claude が別に設計する。

## 背景

- Hub は次の子プロセスを起動する: Agent の CLI（`claude -p ...`、`codex app-server`。`src/agents/agent-process.ts`）、`!command`（`src/cli/command-runner.ts`）、`!& command`（`src/process/process-manager.ts`）、sandbox の broker など
- 止めるのは正常終了の経路だけ（`killProcessTree` = `taskkill /pid <pid> /T /F`）。fatal の例外や `taskkill /F` で Hub が落ちると、Windows では子が残る
- 残ると困るのは、ポートを掴んだままの開発サーバー（`!&`）と、作業を続ける Agent の CLI

## 実測すること

1. **今の挙動**: 擬似の Hub（node のスクリプト）から、次を Hub と同じ spawn のオプションで起動し、Hub を `taskkill /PID <hub> /F` で落としたあと、何が残るかを確かめる
   - stdin を pipe でつないだ長寿命の子（Agent の CLI の代わり。`node -e` で stdin の EOF を待たないもの・待つもの）
   - 実際の `claude -p --input-format stream-json --output-format stream-json` と `codex app-server`（起動するだけでターンは送らない。利用枠は使わない）が stdin の EOF で終わるか
   - PowerShell 経由の孫プロセス（`!&` の開発サーバーの代わり。`node -e "setInterval(()=>{},1000)"` など）
2. **案 A: 見張りのプロセス**: Hub が起動時に detached の見張り（同じ node.exe で動く小さなスクリプト）を起動する。見張りは Hub の pid を監視し、Hub が消えたら、Hub が書いておいた子の pid の一覧（ファイル）を `taskkill /T /F` で止める
   - Hub の終了から子が止まるまでの時間、孫まで止まるか、pid の再利用で無関係のプロセスを止めない工夫（起動時刻の照合など）が要るか
3. **案 B: Job Object**: Hub とは別の helper（PowerShell の `Add-Type` の C#。`src/sandbox/native-source.ts` と同じ方式）が `KILL_ON_JOB_CLOSE` の Job を作り、Hub の子を Job に入れる（`AssignProcessToJobObject`）。helper は Hub の終了を待ち、終わったら Job を閉じる
   - 別のプロセスから Hub の子を Job に入れられるか（同じユーザー）。入れた後に子が起動した孫も Job に入るか
   - Hub が GUI（Tauri）から起動されて、すでに別の Job に入っている場合（入れ子の Job）でも動くか。GUI の起動の仕方は `gui/src-tauri` を見る
   - helper の起動にかかる時間（`Add-Type` のコンパイル）
4. sandbox の中で動く Agent（別ユーザーのプロセス）を A・B で止められるかは、実測が難しければ「未確認」として書く

## 記録

- `docs/spikes/orphan-processes.md`: 実施日・環境、各項目の結果（表）、A と B の比較（確実さ・孫の扱い・実装の量・起動の遅れ）と推奨
- 実測に使ったスクリプトは `spikes/orphan-*.ts`（または `.mjs`・`.ps1`）に置く。テストにする必要はない
- 一時ファイルはリポジトリの外（`%TEMP%`）に作る。実測で起動したプロセスは最後にすべて止める

## 変更してよいファイル

- `spikes/orphan-*`（新規）
- `docs/spikes/orphan-processes.md`（新規）、`docs/spikes/README.md`
