import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHost, psQuote } from "../src/sandbox/powershell.js";

const root = await mkdtemp("E:\\dev\\clodex-hybrid-test\\acl-links-");
const outside = await mkdtemp(join(tmpdir(), "clodex-acl-outside-"));
await mkdir(join(outside, "nested"));
await writeFile(join(outside, "nested", "probe.txt"), "probe");
for (const type of ["junction", "dir"] as const) {
  const link = join(root, type);
  try { await symlink(outside, link, type); }
  catch (error) { console.log(JSON.stringify({ type, error: String(error) })); continue; }
  try {
    console.log(await runHost(`$paths=@(${[root,outside,join(outside,"nested"),join(outside,"nested","probe.txt")].map(psQuote).join(",")});$before=@{};foreach($p in $paths){$before[$p]=Get-Acl -LiteralPath $p};try{$a=Get-Acl -LiteralPath $paths[0];$sid=(Get-LocalUser clodex-agent).SID;$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow'));Set-Acl -LiteralPath $paths[0] -AclObject $a;@($paths|ForEach-Object {@{type=${psQuote(type)};path=$_;changed=($before[$_].Sddl -ne (Get-Acl -LiteralPath $_).Sddl)}})|ConvertTo-Json -Compress}finally{foreach($p in $paths){Set-Acl -LiteralPath $p -AclObject $before[$p]}}`));
  } finally { await unlink(link); }
}
