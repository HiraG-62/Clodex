export function withAdminErrorReport(source: string): string {
  const prelude="$ErrorActionPreference='Stop'";
  if(!source.includes(prelude))throw new Error("管理者スクリプトのエラー設定なし");
  return source.replace(prelude,`${prelude}\n${String.raw`
trap {
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'error'),$_.Exception.Message,[Text.UTF8Encoding]::new($false))
  exit 1
}
`}`);
}
