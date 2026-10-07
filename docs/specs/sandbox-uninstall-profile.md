# sandbox uninstall のプロファイル除去

ユーザー削除前に SID を保存し、削除後に同じ SID の Win32_UserProfile を Remove-CimInstance で除去する。Loaded / Special のプロファイルは削除せずエラーにする。失敗時は既存の管理者処理のエラー経路へ伝播する。

ユーザーと state が既にない場合は、ProfileList の展開・正規化した ProfileImagePath がシステムドライブの Users\clodex-agent と完全一致し、対応するローカルユーザーがいない SID も対象にする。フォルダだけの再帰削除は行わない。人の SID は必ず対象外とする。

テストは PowerShell の CIM・ユーザー・レジストリをスタブ化して、正常削除・孤立プロファイル・別パス・存在ユーザー・Loaded・削除失敗を検証する。実機の UAC / uninstall は人が行う。
