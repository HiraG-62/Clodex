# OTHER-PROJECT-NOTICE: ほかの project で Agent のターンが終わったら知らせる

project A で Agent が作業中に project B へ切り替えると、A の作業が終わっても何も出ない。`Workspace.handleEvent`（`src/hub/workspace.ts`）は「project の中で今の会話か」だけを見て toast を出すかを決めており、A の今の会話は B に切り替えても「今の会話」のままだから。仕様の正は `docs/DESIGN.md` §28 D2a の「裏で動いている会話」の項。

## 変更

- `Workspace` の options に、その project が今の project かを返す関数（例: `isCurrentProject: () => boolean`）を足す。`src/hub/project-context.ts` は既にある `isCurrent` を渡す
- `handleEvent` の「裏の会話か」の判定を「今の会話でない、または今の project でない」にする
  - 今の project の今の会話: 今どおり何も出さない
  - 今の project の裏の会話: 今どおり `notice.background`
  - ほかの project の会話（その project の今の会話を含む）: `notice.background` の前に project 名（project root のフォルダ名）を付ける。例: ja `roguelike · 「会話名」の claude のターンが終わりました（completed）`。文言は `notice.backgroundProject`（ja `{project} · {text}` / en `{project} · {text}`）のように project 名を足すだけのキーにする
- toast の level は今どおり（completed は info、それ以外は warn）
- `project-context.ts` の `print`（terminal）は今どおり今の project だけ。toast は `notify` 経由なので今の project 以外でも feed に流れる。流れない場合は、ほかの project の `notify` が今の feed に届くように直す（`index.ts` の `notify` は Hub 全体の feed に publish しているので届く見込み。テストで確かめる）

## 追加: 裏の会話の質問と Web Push

- 裏で動いている会話（今の project の裏の会話と、ほかの project の会話）で `question` event が出たら toast で知らせる。文言キーは `notice.backgroundQuestion`（ja `「{title}」の {agent} から質問` / en `"{title}": question from {agent}`）。ほかの project なら上と同じく project 名を前に付ける
- 裏の会話のターン終了と質問は Web Push にも送る
  - `Workspace` の `notify` に種類を渡せるようにする（例: `notify(text, level, kind?: "finished" | "question")`）。`project-context.ts` を通して `index.ts` の `notify` まで届ける
  - `index.ts` の `notify` は、種類があれば toast に加えて `push.notify({ title, body: text })` を送る。title は今の会話の通知と同じ（finished: `desktop.notify.finished`、question: `web.question.title`）。送信の失敗は今の push と同じく `reportRuntimeError`
  - 今の会話の通知（`updateDesktopNotify` 経由）は今どおり。裏の会話の分が二重に送られないこと（裏の会話の event は今の feed に流れないので重ならない見込み。テストで確かめる）

## テスト方針

- `workspace.test.ts`（追加）: 裏の会話の `question` で `notice.backgroundQuestion`、ほかの project なら project 名付き。ターン終了は kind `finished`、質問は kind `question` で notify される
- `index.ts` の push の分岐は小さな関数に切り出せるならテストする（種類あり → push、なし → toast だけ）
- `workspace.test.ts`
  - 今の project の今の会話のターン終了: notify しない
  - 今の project の裏の会話: 今の文言で notify
  - 今の project でないとき、今の会話のターン終了でも project 名付きで notify
- 可能なら `project-context` か Hub の結合テストで、今の project でない context のターン終了が `notify` に届くこと
- `pnpm test` と `pnpm typecheck`。コミットはしない
