# IMAGE-AND-OWNERSHIP: 画像を確実に見せる・設計書の所有範囲

roguelike での運用からの改善案（1・5）。Agent が画像のパスを ask_user の質問文や最初の発言に書いても表示されず、`![](<パス>)` でも出なかった。設計書の所有範囲の抜けで、範囲を確かめる QUESTION が 3 回往復した。仕様の正は `docs/DESIGN.md` §28 B「成果物のプレビュー」と「Spec（設計書）」。

## 1. 画像

- **Markdown の画像記法**（`src/web/client/markdown.ts`）: `renderer.image` が説明の文字だけを返しているので、パスが消えて `linkImagePaths` に拾われない。`![説明](<パス>)` は、パス（href）を本文の文字として出す（例: 説明があれば `説明 パス`、無ければパスだけ。escape する）。画像として埋め込まない
- **プレビューの範囲**（`src/web/client/client-main.ts`）: 今 `appendImagePreviews` を呼んでいるのは最終応答・人の入力・message。次を足す
  - ターンの方針（最初の発言。`plan`）
  - 質問欄の質問文と選択肢の説明（`renderQuestionDock`）
  - ログの質問の記録（`renderQuestion`）
- **役割の定型文**（`src/context/role-instructions.ts` の `artifactsNote`）: 次の内容にする（英語）。「To show the human an image, save it under <dir> and write its full path in your final reply or in an ask_user question, either as the plain path or as a Markdown link [name](<full path>). It is shown as a preview. Paths in intermediate progress notes are not shown.」
- ask_user の schema は変えない（質問文のパスがプレビューになる）

## 5. 設計書の所有範囲

- 役割の定型文の `SPEC_NOTE`（`src/context/role-instructions.ts`）に足す（英語）: 「In the spec, include the files that generation commands (build, codegen, dictionary updates) rewrite in the files the implementer may change. Updating files rewritten by generation commands is allowed by default.」

## テスト方針

- `markdown.test.ts`: `![説明](<C:\x\a.png>)` がパスを文字として含み、`<img` を出さない
- 質問欄・方針のプレビュー: プレビューを出す対象を決める部分を純粋な関数に切り出せるならテストする。難しければ `web-page.test.ts` の既存の形で、埋め込んだ client のコードに呼び出しがあることを確かめる
- `role-instructions.test.ts`: 画像の書き方と所有範囲の文が入る
- 見た目は Playwright で、質問欄に画像のパス付きの質問を出した状態を確かめる（ビルド版の Hub、`CLODEX_HOME=<空の一時フォルダ>`、別ポート。一時ファイルはリポジトリの外）。スクリーンショットを `C:\Users\Horry\.clodex\artifacts\E--dev-Clodex-ce95cf0d\` に保存して RESULT に path を書く
- `pnpm test` と `pnpm typecheck`。コミットはしない。終わったら `send_message` の RESULT で報告する
