# Hub の異常終了と子プロセス

実施日: 2026-10-10。Windows 11 Pro 10.0.26200、Node 22.13.1、Windows PowerShell 5.1。再現スクリプトは `spikes/orphan-probe.mjs` と `spikes/orphan-job.ps1`。一時ファイルは `%TEMP%/clodex-orphan-*` に作成した。

`node spikes/orphan-probe.mjs run` と `node spikes/orphan-probe.mjs run-job` を実行した。擬似 Hub は製品と同じ `windowsHide: true`、Agent 相当は `stdio: ['pipe', 'pipe', 'pipe']`、シェル相当は `stdio: ['ignore', 'pipe', 'pipe']` で起動した。Hub だけを `taskkill /PID <hub> /F`（`/T` なし）で止め、残存 PID を検査した。実 CLI は起動しただけで、ターンは送っていない。計測後、全対象 PID を `taskkill /T /F` で停止し、残存がないことを確認した。

## 今の挙動

| 子プロセス | Hub 停止の約 1.5 秒後 | 結果 |
|---|---|---|
| Node、stdin の EOF を待たない `setInterval` | 終了 | Hub の終了に伴い終了した。終了理由の切り分けは未実施 |
| Node、stdin の EOF で `process.exit(0)` | 終了 | EOF を受ける構成は終了した |
| 実 `claude -p --input-format stream-json --output-format stream-json` | 終了 | ターン送信なし |
| 実 `codex app-server` | 終了 | ターン送信なし |
| PowerShell 経由で起動した Node | PowerShell は終了、孫 Node は残存 | 開発サーバーに相当する孫の孤児化を再現 |

この結果から、Agent CLI が必ず残るとはいえないが、孫プロセスは実際に残る。EOF に依存する停止は、子が stdin を監視しない場合やシェルが孫を起動する場合の保証にならない。

## 案 A: detached の見張り

見張り Node が 100 ms 間隔で Hub の PID を監視し、Hub が消えたらファイルに記録した直下の子 PID に `taskkill /T /F` を実行した。

| 対象 | Hub 停止から検知 | `taskkill` 完了 | 孫の結果 |
|---|---:|---:|---|
| Node 直下の子 | 896 ms | 901 ms | なし |
| PowerShell → Node | 825 ms | 885 ms | 孫 Node は残存 |

後者では見張りが動く前に PowerShell が終わり、`taskkill /T` の起点となる親子関係が失われた。PID 一覧に孫も記録する仕組みが必要。見張りが遅れて PID が再利用された場合、無関係なプロセスを止めうるため、登録時の起動時刻と停止直前の起動時刻の照合も必要になる。この試作では時刻照合は実装していない。

## 案 B: Job Object

別プロセスの PowerShell helper が `Add-Type` で Win32 API を呼び、`KILL_ON_JOB_CLOSE` を設定した Job を作成。同じユーザーの擬似 Hub の子を `AssignProcessToJobObject` で登録した。helper は Hub のプロセスハンドルを待ち、終了後に Job を閉じた。

| 条件 | 登録結果 | Hub 終了後の子・孫 | `Add-Type` まで | helper 起動から登録まで |
|---|---|---|---:|---:|
| Node の子 | 成功 | 子は終了 | 689 ms | 733 ms |
| PowerShell を Job に登録後、孫 Node を起動 | 成功 | 両方終了 | 963 ms | 1008 ms |
| 孫 Node 起動後、PowerShell を Job に登録 | 成功 | 孫 Node は残存 | 644 ms | 686 ms |
| Hub を先に別の Job に登録（GUI から起動された場合を模擬）し、子を内側の Job に登録 | 成功 | 子・孫とも終了 | 774 ms | 835 ms |

Hub 強制終了から helper が Job を閉じるまで、上記の順で 466、632、599、385 ms。別プロセスから同じユーザーの子を登録でき、登録後に起動した孫は Job を継承した。登録前に起動済みの孫は遡って登録されない。入れ子の Job は、この Windows 11 環境で成功した。GUI は `gui/src-tauri/src/lib.rs` で `CREATE_NO_WINDOW` を付けて Hub を起動するが、Job に入れる処理はない。実 GUI が外部の Job に入っているかは未確認。

## 比較と推奨

| 観点 | A: 見張り | B: Job Object |
|---|---|---|
| 強制終了後の確実さ | 見張りの検知までに親子関係が消える | 登録済みプロセスと後続の子孫は Job close で停止 |
| 孫プロセス | 親が先に終了すると残る | 登録後に起動した孫は継承。登録前の孫は残る |
| 実装の量 | PID と起動時刻の記録・照合、孫の追跡が必要 | Win32 helper、Job の所有と起動時の同期が必要 |
| 起動の遅れ | Node 見張りの起動と監視開始待ち | PowerShell `Add-Type` に約 0.6〜1.0 秒 |

**B を推奨する。** Hub を Job に登録し終わるまで Agent やシェルを起動しない構成なら、子孫が自動で Job に入り、見張りで発生した親子関係の消失を避けられる。登録と起動の順序は必須条件。Hub 自身を登録する設計は、この試作では外側の Job の模擬までで、helper が管理する Job への Hub 登録から全子孫の停止までを一体では実測していない。

sandbox 内の別ユーザーの Agent を A・B で停止できるかは未確認。別ユーザーのプロセスに対する `OpenProcess` と Job 登録、または継承の可否を実装前に確認する必要がある。
