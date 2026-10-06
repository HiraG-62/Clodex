import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";
import { psQuote, runHost } from "../src/sandbox/powershell.js";

const project = "E:\\dev\\clodex-hybrid-test";
const source = String.raw`
using System;using System.Diagnostics;using System.Runtime.InteropServices;
class Probe {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct Entry{public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string name;}
  [DllImport("kernel32.dll")]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32First(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32Next(IntPtr snapshot,ref Entry entry);
  static int Parent(int pid){var h=CreateToolhelp32Snapshot(2,0);try{var e=new Entry();e.size=(uint)Marshal.SizeOf(e);for(bool ok=Process32First(h,ref e);ok;ok=Process32Next(h,ref e)){if(e.pid==pid)return (int)e.parent;}throw new Exception("parent missing");}finally{CloseHandle(h);}}

  [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint rights,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenThread(uint rights,bool inherit,int tid);
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)]static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attributes,int level,int type,out IntPtr result);
  [DllImport("advapi32.dll",SetLastError=true)]static extern bool RevertToSelf();
  [DllImport("kernel32.dll")]static extern IntPtr GetCurrentThread();
  [StructLayout(LayoutKind.Sequential)]struct Qos{public int length,level;public byte tracking,effective;}
  [DllImport("ntdll.dll")]static extern int NtImpersonateThread(IntPtr target,IntPtr source,ref Qos qos);
  static void Test(int pid){
    var process=OpenProcess(0x1000,false,pid);if(process!=IntPtr.Zero){foreach(uint access in new uint[]{2,4,0x20,0x40000}){IntPtr token;bool ok=OpenProcessToken(process,access,out token);Console.WriteLine("token="+pid+" mask="+access+" error="+(ok?0:Marshal.GetLastWin32Error()));if(ok){if(access==2){IntPtr copy;bool duplicated=DuplicateTokenEx(token,0,IntPtr.Zero,2,2,out copy);Console.WriteLine("DuplicateTokenEx="+(duplicated?0:Marshal.GetLastWin32Error()));if(duplicated)CloseHandle(copy);}CloseHandle(token);}}CloseHandle(process);}else Console.WriteLine("token="+pid+" prerequisite OpenProcess="+Marshal.GetLastWin32Error()+"; OpenProcessToken/DuplicateTokenEx 未到達");

    foreach(uint right in new uint[]{0x1fffff,0x400,0x1000,0x40,0x20,2}){IntPtr h=OpenProcess(right,false,pid);Console.WriteLine("process="+pid+" mask="+right+" error="+(h==IntPtr.Zero?Marshal.GetLastWin32Error():0));if(h!=IntPtr.Zero)CloseHandle(h);}
    try{foreach(ProcessThread thread in Process.GetProcessById(pid).Threads){foreach(uint rights in new uint[]{0x10,0x100,0x200}){IntPtr h=OpenThread(rights,false,thread.Id);Console.WriteLine("thread="+thread.Id+" mask="+rights+" error="+(h==IntPtr.Zero?Marshal.GetLastWin32Error():0));if(h!=IntPtr.Zero){if(rights==0x200){var q=new Qos();q.length=Marshal.SizeOf(q);q.level=2;int status=NtImpersonateThread(GetCurrentThread(),h,ref q);Console.WriteLine("NtImpersonateThread="+status);RevertToSelf();}CloseHandle(h);}else if(rights==0x200)Console.WriteLine("NtImpersonateThread 未到達: source handle 拒否");}}}catch(Exception e){Console.WriteLine(e.GetType().Name);}
  }
  static void Main(string[] args){Console.OutputEncoding=new System.Text.UTF8Encoding(false);int pid=Int32.Parse(args[0]);for(int n=0;n<3;n++){Test(pid);pid=Parent(pid);}}
}`;
await mkdir(project, { recursive: true });
const cs = join(project, "process-access.cs");
const exe = join(project, "process-access.exe");
await writeFile(cs, source);
await runHost(`& "$env:SystemRoot\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe" /nologo ${psQuote(`/out:${exe}`)} ${psQuote(cs)};if($LASTEXITCODE -ne 0){throw 'compile'}`);
const platform = new WindowsSandboxPlatform(homedir(), project);
const results: Array<{ name: string; code: number | null; output: string }> = [];
const runId = randomUUID();
async function run(name: string, command: string, args: string[]) {
  const proc = platform.spawn(command, args, { cwd: project, env: {} });
  const result = await new Promise<{ name: string; code: number | null; output: string }>((resolve) => {
    const output: string[] = [];
    const timer = setTimeout(() => { proc.kill(); resolve({ name, code: null, output: output.join("\n") + "\nタイムアウト" }); }, 45_000);
    proc.onLine(line => output.push(line));
    proc.onExit(code => { clearTimeout(timer); resolve({ name, code, output: output.join("\n") }); });
    proc.spawned.catch((error: unknown) => { clearTimeout(timer); resolve({ name, code: null, output: String(error) }); });
  });
  results.push(result); console.log(JSON.stringify(result));
}
const node = (name: string, script: string) => run(name, "node", ["-e", script]);
const captured = (name: string, command: string, args: string[]) => node(name, `const {spawnSync}=require('child_process');const command=${JSON.stringify(command)};const args=${JSON.stringify(args)};const script=['pnpm.cjs','pnpm.mjs'].map(name=>require('path').join(process.env.APPDATA,'npm/node_modules/pnpm/bin',name)).find(p=>require('fs').existsSync(p));const r=command==='pnpm'?spawnSync(process.execPath,[script,...args],{encoding:'utf8'}):spawnSync(command,args,{encoding:'utf8'});console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message}));process.exitCode=r.status??1`);
const ps = (name: string, executable: string, script: string) => run(name, executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
try {
  if (!await platform.inspect()) throw new Error("セットアップ未完了");
  await platform.connect(false);
  await platform.grant(project, false);
  await run("token", "__inspect", []);
  await node("脱出ハンドル", `const {spawnSync}=require('node:child_process');const p=spawnSync(${JSON.stringify(exe)},[String(process.ppid)],{encoding:'utf8'});console.log(JSON.stringify({status:p.status,stdout:p.stdout,stderr:p.stderr,error:p.error?.message}));process.exit(p.status??1)`);
  for (const cli of ["claude", "codex"]) await run(cli, cli, ["--version"]);
  const windowsPs = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  for (const shell of [windowsPs, "C:\\Program Files\\PowerShell\\7\\pwsh.exe"]) await ps(shell, shell, "$PSVersionTable.PSVersion.ToString()");
  await ps("HKCU", windowsPs, `$ErrorActionPreference='Stop';$path='Software\\ClodexProbe-${runId}';try{$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path);$key.SetValue('probe','ok');$key.GetValue('probe');$key.Dispose()}finally{[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($path,$false)}`);
  await node("Node 子プロセス", "const r=require('child_process').spawnSync(process.execPath,['-e','console.log(42)'],{encoding:'utf8'});console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message}));process.exitCode=r.status??1");
  await node("読み取り", `for(const p of ['E:\\\\','C:\\\\Program Files',process.env.USERPROFILE,${JSON.stringify(homedir())}]){try{require('fs').readdirSync(p);console.log(p+': 成功')}catch(e){console.log(p+': '+e.code)}}`);
  await ps("pnpm の場所", windowsPs, "Get-Command pnpm -All | Select-Object Source | ConvertTo-Json -Compress; Get-ChildItem -LiteralPath \"$env:APPDATA\\npm\\node_modules\\pnpm\\bin\" | Select-Object Name | ConvertTo-Json -Compress");
  await node("pnpm 環境", "console.log(JSON.stringify({npm_config_package_import_method:process.env.npm_config_package_import_method,NPM_CONFIG_PACKAGE_IMPORT_METHOD:process.env.NPM_CONFIG_PACKAGE_IMPORT_METHOD}))");
  await captured("pnpm config", "pnpm", ["config", "get", "package-import-method"]);
  const work = join(project, `restricted-${runId}`);
  await mkdir(work);
  await writeFile(join(work, "package.json"), '{"name":"restricted-probe","private":true,"dependencies":{"is-number":"7.0.0"}}');
  await captured("pnpm install", "pnpm", ["--dir", work, "install", "--ignore-scripts"]);
  await captured("pnpm install copy", "pnpm", ["--dir", work, "install", "--ignore-scripts", "--package-import-method=copy"]);
  await node("pnpm store ファイル操作", `const fs=require('fs'),p=require('path');const source=p.join(${JSON.stringify(project)},'.pnpm-store/v11/files/72/392bccd8964c88ec8aa3d815746a2b6a4466d9c7ca8f428d7d0f3e2bb11674ef494ca335c8b255eee5825c087a77bb45a5d60025f318b78a64e19beccd23c7');for(const op of ['read','link','copy']){const target=p.join(${JSON.stringify(work)},'probe-'+op);try{if(op==='read')fs.readFileSync(source);else if(op==='link')fs.linkSync(source,target);else fs.copyFileSync(source,target);console.log(op+': 成功')}catch(e){console.log(op+': '+e.code+' '+e.message)}finally{if(fs.existsSync(target))fs.unlinkSync(target)}}`);
  await run("git init", "git", ["init", work]);
  await captured("git commit", "git", ["-C", work, "-c", `safe.directory=${work.replaceAll('\\','/')}`, "-c", "user.name=ClodexSpike", "-c", "user.email=spike@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(work,"empty-hooks")}`, "commit", "--allow-empty", "-m", "restricted-probe"]);
  await node("HTTPS", "fetch('https://registry.npmjs.org/is-number/latest').then(async r=>{console.log(r.status);await r.arrayBuffer()}).catch(e=>{console.error(e);process.exitCode=1})");
  const mcp = new McpServer({ name: "sandbox-probe", version: "1" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  const http = createServer((req,res) => { void transport.handleRequest(req,res).catch(()=>res.end()); });
  await new Promise<void>(done=>http.listen(0,"127.0.0.1",done));
  try {
    const address=http.address(); if(!address || typeof address==='string') throw new Error("MCP ポートなし");
    const body={jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"probe",version:"1"}}};
    await node("MCP", `fetch('http://127.0.0.1:${address.port}',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>console.log(await r.text())).catch(e=>{console.error(e);process.exitCode=1})`);
  } finally { await transport.close(); http.closeAllConnections(); await new Promise<void>(done=>http.close(()=>done())); }
} finally {
  try { await platform.release(); } finally { await platform.close(); }
  const output=join(homedir(),'.clodex',`sandbox-process-access-${runId}.json`);
  await writeFile(output,JSON.stringify({runId,results},null,2));console.log(`記録: ${output}`);
}
