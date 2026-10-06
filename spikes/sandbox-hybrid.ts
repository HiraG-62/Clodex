import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenHelperSource } from "./sandbox-token.js";
import { psQuote } from "./sandbox-user.js";

const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
interface Audit { path: string; deny?: boolean; error?: string; rules?: unknown }
export function assessAudit(items: Audit[]): { denied: string[]; unknown: string[] } {
  return { denied: items.filter(item => item.deny).map(item => item.path), unknown: items.filter(item => item.error).map(item => item.path) };
}

export const hybridHelperSource = tokenHelperSource.replace('if(args.Length==2 && args[0]=="--delete")', `if(args.Length==2 && args[0]=="--boundary") {
        const uint GENERIC_WRITE=0x40000000, SHARE_ALL=7, CREATE_NEW=1;
        var file=CreateFile(args[1],GENERIC_WRITE,SHARE_ALL,IntPtr.Zero,CREATE_NEW,0,IntPtr.Zero);
        int createError=file==new IntPtr(-1)?Marshal.GetLastWin32Error():0;
        if(createError==0)CloseHandle(file);
        int deleteError=createError==0?(DeleteFile(args[1])?0:Marshal.GetLastWin32Error()):-1;
        Console.WriteLine("{\\"createError\\":"+createError+",\\"deleteError\\":"+deleteError+"}");return 0;
      }
      if(args.Length==2 && args[0]=="--delete")`);

async function main(): Promise<void> {
  if (process.argv.slice(2).some(arg => !["--audit-only", "--cleanup"].includes(arg))) throw new Error("不明な引数");
  const clodex = join(homedir(), ".clodex");
  const state = JSON.parse(await readFile(join(clodex, "sandbox-user-state.json"), "utf8")) as { agentSid: string; humanSid: string; project: string; artifacts: string; complete: boolean; deniedDrives: string[] };
  if (![state.agentSid, state.project, state.artifacts].every(value => typeof value === "string" && value.length > 0)) throw new Error("state が不正");
  const paths = ["D:\\", "E:\\", "E:\\dev", "E:\\dev\\Clodex", "E:\\dev\\Clodex\\spikes", state.project, state.artifacts];
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$env:PSModulePath="$PSHOME\\Modules";@(${paths.map(psQuote).join(",")}) | ForEach-Object { $p=$_;try{$a=Get-Acl -LiteralPath $p -ErrorAction Stop;$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -eq ${psQuote(state.agentSid)}});@{path=$p;deny=(@($rules|Where-Object AccessControlType -eq Deny).Count -gt 0);rules=@($rules|Select-Object AccessControlType,FileSystemRights,IsInherited,InheritanceFlags)}}catch{@{path=$p;error=$_.Exception.Message}}}|ConvertTo-Json -Depth 8 -Compress`;
  const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  const code = await new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("close", done); });
  if (code !== 0) throw new Error(stderr);
  const audit = JSON.parse(stdout) as Audit[];
  const result = { date: new Date().toISOString(), state, audit, assessment: assessAudit(audit) };
  const output = join(clodex, `sandbox-hybrid-audit-${randomUUID()}.json`);
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`記録: ${output}`);
  if (process.argv.includes("--audit-only")) return;
  if (audit.some(item => ["E:\\", "E:\\dev", "E:\\dev\\Clodex"].includes(item.path) && (item.deny || item.error))) throw new Error("E: の判定対象に Deny または監査不能あり");
  const { runHybrid } = await import("./sandbox-hybrid-runner.js");
  await runHybrid(state, hybridHelperSource, process.argv.includes("--cleanup"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
