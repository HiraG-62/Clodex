# sandbox の Git 作者設定

`/sandbox on` の project grant で safe.directory を確認する前に、人の global user.name / user.email を読み、存在する値だけ agent の global へ --replace-all で設定する。既に safe.directory 登録済みでも同期する。off では作者設定を消さない。

読み取り結果は JSON で受け取り、値の空白・日本語・引用符を保存する。agent への設定は broker の引数配列で渡し、シェル文字列へ埋め込まない。未設定の exit 1 以外の失敗は呼び出し元へ返す。
