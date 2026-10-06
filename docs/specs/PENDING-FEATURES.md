# PENDING-FEATURES: `@all`、`!&` の background process、GUI の通知とトレイ常駐

設計の正は `docs/DESIGN.md`（§8 の `@all`、§15 Process Manager、§28「D3 の詳細」の「通知とトレイ常駐」）。この文書は実装の範囲と受入条件をまとめる。3 つは互いに独立しているので、コミットは 1 つずつ分ける（RESULT で、どのファイルの変更がどれに属するかを書く。`src/i18n/messages.ts` のように共有するファイルは、どの key がどれのものかを書く）。

## 1. `@all`

- `src/cli/input.ts`: `@all <text>` を `{ kind: "sendAll"; text; steer?: true }` に変える（`@all!` は steer）。本文が空なら `@claude` と同じ invalid。`unsupported("@all")` は消す
- `src/cli/shell.ts`: `resolveReferences` は 1 回だけ行い、両 Agent（`AGENT_IDS` の順）へ `send` と同じ処理をする。Agent に渡す本文の先頭に `[Sent to both claude and codex]` の 1 行を足す（Agent 向けなので i18n の対象外。定数にする）。送るたびに `notice` を出す（文言は i18n。例: `@all: claude と codex に送信` / `@all: sent to claude and codex`）
  - notice の出し方は既存の `notice.sameDirBusy` と同じ経路（`print` でよいか、Event Bus の notice か）に揃える
- 入力の候補（`src/web/client/input-assist.ts` の `@` の後の候補）と強調表示（`compose-input.ts` 等）で `all` を Agent 名と同じに扱う。TUI も同じ `createInputAssist` を使うので自然に入るはず
- `/help` の一覧に `@all` を足す（`cli/commands.ts` にあれば）

テスト: input の解釈（`@all`、`@all!`、空の本文）、shell で両 Agent にそれぞれ 1 件積まれ、本文の先頭に 1 行が付き、notice が出る。候補に `@all` が出る。

## 2. `!&` の background process

- 新規 `src/process/process-manager.ts`（名前は任せる）。Hub で 1 つ（`src/index.ts` で `createCommandRunner` と同じ場所で作る）
  - shell の起動・UTF-8 の prefix・終了コードの suffix・pwsh → powershell のフォールバック・行の分割は `command-runner.ts` と共有する（コピーしない。必要なら関数を切り出す）
  - `start(command)`: 番号（1 から、使い回さない）を振って起動し、`#1 started: <command>` を print。cwd は起動時の今の会話の作業場所
  - 出力は print しない。process ごとに最後の 200 行（定数）を持つ
  - 終了で `#1 exit <code> (<秒>s): <command>`、`kill` で止めたときは `#1 stopped (<秒>s): <command>` を print
  - `list()`: `{ id, command, status: "running" | "exited" | "stopped", exitCode?, startedAt, endedAt? }`
  - `output(id)`: 持っている行
  - `kill(id)`: プロセスツリーごと止める（`killProcessTree`）。無い番号・終わった番号は false
  - `stopAll()`: `/exit` と Hub の終了で呼ぶ
- `src/cli/input.ts`: `!& <command>` → `{ kind: "background"; command }`（空なら usage）。`/processes [番号]`、`/kill <番号>`
- `src/cli/shell.ts`: 上を処理する。Ctrl+C（`handleSigint`）と `/interrupt` では止めない。`/processes` の一覧は 1 process 1 行（`#1 running 12.3s  pnpm dev`、`#2 exit 1 3.2s  pnpm test`）。空なら 1 行（例: `background process はありません`）。`/processes <番号>` は出力の行をそのまま、無ければその旨
- `cli/commands.ts`（コマンドの一覧）に `/processes`・`/kill` を足し、`/help`・候補に出す。`/kill` と `/processes` の引数の候補は state の一覧の番号（`/kill` は running のものだけ）と command
- state（`src/index.ts` の `connectWebFeed` に渡す state と、その型）に `processes: { id, command, status }[]` を足す
- Web UI と TUI の入力欄の「コマンド入力」の見た目は、今の「先頭が `!`」の判定のままで `!&` も含まれるので変えない

テスト: input の解釈、process manager（fake の spawn で: 番号、200 行で古い行が落ちる、exit・stopped の行、kill の戻り値、stopAll）、shell で Ctrl+C・`/interrupt` が background を止めないこと、`/exit` で止めること、`/processes` の表示。

## 3. GUI の通知とトレイ常駐

Web UI 側（TypeScript）:

- 新規 `src/web/client/desktop-notify.ts`（名前は任せる）に、通知を出すかどうかと内容を決める純関数を置く。入力は feed の項目（live で届いたもの）と、今の会話の作業中かどうか。出力は `{ title, body } | undefined`
  - 作業中 → 作業終了（どの Agent も busy でなく、配送待ちの入力も無い）に変わったとき: 最後に終わったターンの Agent 名と最終応答の 1 行目（長ければ切る。長さは定数）。失敗・中断ならその状態の文言
  - `notice` と `error`
  - feed の読み込み（`reset` の後の再生や初回の読み込み）の項目では出さない。live かどうかの見分け方は今の client の作りに合わせる
- `client-main.ts`: `window.__TAURI__` があり、`document.hidden || !document.hasFocus()` のときだけ、Tauri の notification plugin（`window.__TAURI__.notification` の `isPermissionGranted` / `requestPermission` / `sendNotification`）で出す。ブラウザでは何もしない
- 文言は i18n の文言カタログから引く

GUI 側（`gui/src-tauri`）:

- `tauri-plugin-notification` を追加し、`capabilities` に通知の権限を足す（remote の `http://127.0.0.1:*/*` から使えること）
- トレイ: tauri の `tray-icon` feature。アイコンはアプリのアイコン、tooltip は `Clodex`。左クリックでウィンドウを出してフォーカス。メニューは「開く」「終了」（Rust の定数）。「終了」で `app.exit(0)`（今の `RunEvent::Exit` で、GUI が起動した Hub を止める処理が走ること）
- ウィンドウの × は終了せず隠す（`CloseRequested` で `prevent_close` して `hide`）
- `tauri-plugin-single-instance`: 2 回目の起動は既存のウィンドウを出してフォーカスし、自分は終わる
- `gui/README.md` に、閉じるとトレイに残ること、終了はトレイのメニューからであることを足す

テスト: `desktop-notify` の純関数（作業終了で 1 回だけ、作業中のままでは出ない、notice・error、再生では出ない、1 行目と長さの切り詰め）。Rust は単体テストを足さなくてよい。

受入（codex が実機で確かめて RESULT に書く。確かめられなかったものはそう書く）:

- `pnpm gui:build` が通る
- 一時的な HOME で release の `clodex-gui.exe` を起動し、× でウィンドウが消えても GUI と Hub のプロセスが残ること、2 回目の起動で新しいプロセスが残らないこと
- 通知とトレイのメニューの操作は自動で確かめにくいので、確かめられた範囲を書く（人が後で確かめる）
- 実ユーザーの `~/.clodex` には触れない。Agent にメッセージは送らない（E2E はしない）

## 共通

- `pnpm test`、`pnpm typecheck` を通す。GUI を変えたら `cargo check` と `cargo fmt --check` も
- 3 つは互いに独立しているので、サブエージェントで並列に進めてよい（`src/i18n/messages.ts`・`src/cli/shell.ts`・`src/cli/input.ts` は 1 と 2 で重なるので、そこは衝突しないように）
- コミットはしない
