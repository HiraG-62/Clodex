import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { t } from "../i18n/i18n.js";
import { isMissing } from "./git-protection.js";
import { psQuote, runHost } from "./powershell.js";

type Host = (script: string) => Promise<string>;
async function runtimeEntries(root: string): Promise<Array<{ path: string; directory: boolean }>> {
  const resolved = resolve(root);
  for (let path = resolved; ; path = dirname(path)) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(t("sandbox.reparse", { path }));
    if (dirname(path) === path) break;
  }
  const entries: Array<{ path: string; directory: boolean }> = [];
  const visit = async (path: string): Promise<void> => {
    if (relative(resolved, path).startsWith("..")) throw new Error(t("sandbox.pathDenied", { path }));
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(t("sandbox.reparse", { path }));
    if (stat.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
    entries.push({ path, directory: stat.isDirectory() });
  };
  await visit(resolved);
  return entries;
}
async function clearRuntime(root: string, removeRoot: boolean): Promise<void> {
  const entries = await runtimeEntries(root);
  for (const entry of entries) {
    if (!removeRoot && entry.path === resolve(root)) continue;
    if (entry.directory) await rmdir(entry.path);
    else await unlink(entry.path);
  }
}
function validateRoot(root: string, human: string): void {
  if (basename(resolve(root)) !== `Clodex-Sandbox-${human}`) throw new Error(t("sandbox.pathDenied", { path: root }));
}
const ownerCheck = (root: string, human: string) =>
  `$path=${psQuote(root)};$human=[Security.Principal.SecurityIdentifier]::new(${psQuote(human)});$old=Get-Acl -LiteralPath $path;if($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $human.Value){throw ${psQuote(t("sandbox.runtimeAcl"))}};`;

export async function prepareRuntimeDirectory(root: string, human: string, agent: string, host: Host = runHost): Promise<void> {
  validateRoot(root, human);
  try {
    await runtimeEntries(root);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const changed = await host(
    `$path=${psQuote(root)};$human=[Security.Principal.SecurityIdentifier]::new(${psQuote(human)});$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($human);$acl.SetAccessRuleProtection($true,$false);foreach($sid in @($human.Value,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new(${psQuote(agent)}),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'));function Signature($a){@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {"$($_.IdentityReference.Value):$([int]$_.FileSystemRights):$([int]$_.InheritanceFlags):$([int]$_.PropagationFlags):$([int]$_.AccessControlType)"}|Sort-Object)-join ';'};$changed=$false;if(Test-Path -LiteralPath $path){${ownerCheck(root, human)}$changed=(-not $old.AreAccessRulesProtected) -or ((Signature $old) -ne (Signature $acl));if($changed){[IO.Directory]::SetAccessControl($path,$acl)}}else{[void][IO.Directory]::CreateDirectory($path,$acl)};$changed|ConvertTo-Json -Compress`,
  );
  if (changed.trim() === "true") await clearRuntime(root, false);
}

export async function removeRuntimeDirectory(root: string, human: string, host: Host = runHost): Promise<void> {
  validateRoot(root, human);
  try {
    await runtimeEntries(root);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await host(ownerCheck(root, human));
  await clearRuntime(root, true);
}
