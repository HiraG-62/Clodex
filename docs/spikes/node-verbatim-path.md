# 同梱 node と `\\?\` 付きのパス

Tauri の `resource_dir()` は Windows で `\\?\C:\...` 形式（verbatim パス）を返す。これを entry として node に渡した結果。

| node | `\\?\C:\...\index.js` | `C:\...\index.js` |
| --- | --- | --- |
| v22.13.1（ローカル） | 起動する | 起動する |
| v22.23.3（release の CI で同梱） | `EISDIR: illegal operation on a directory, lstat 'C:'` で終了 | 起動する |

v0.1.0 の GUI はこのため Hub を起動できなかった。GUI は `dunce::simplified` で接頭辞を外してから node に渡す。
