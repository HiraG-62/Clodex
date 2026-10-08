// Spike: !command の構文エラーが化けないよう、command を base64 で埋め込んで UTF-8 指定の後に構文解析させる（docs/spikes/shell-command.md）
import { spawnSync } from "node:child_process";
const PREFIX = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ";
const SUFFIX = "\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }";
const wrap = (c) => `${PREFIX}. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(c + SUFFIX, "utf8").toString("base64")}'))))${SUFFIX}`;
const inline = (c) => `${PREFIX}${c}${SUFFIX}`;
const cases = ["! git push", "echo 日本語", "cmd /c exit 3", "cmd /c exit 3; echo after", "Get-Item C:/nope", "Get-Item C:/nope; echo after", "$x = 5", "echo $x", "exit 7", "Write-Error ああ"];
for (const shell of ["pwsh", "powershell"]) for (const c of cases) for (const [name, f] of [["inline", inline], ["wrap", wrap]]) {
  const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", f(c)], { encoding: "utf8", windowsHide: true });
  console.log(shell, name, JSON.stringify(c), "exit", r.status, JSON.stringify((r.stdout + r.stderr).replace(/\s+/g, " ").slice(0, 90)));
}
