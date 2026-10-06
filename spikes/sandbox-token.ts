import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ClaudeAdapter } from "../src/agents/claude-adapter.js";
import { CodexAdapter } from "../src/agents/codex-adapter.js";
import { subscriptionEnv, type SpawnAgentProcess } from "../src/agents/agent-process.js";
import { formatTable, psQuote } from "./sandbox-user.js";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const TIMEOUT_MS = 90_000;
const TURN_TIMEOUT_MS = 180_000;
const LABELS = ["起動・子への継承", "書き込み境界", "読み取り", "ツール", "レジストリ", "ネットワーク", "停止", "所有者", "MCP", "実 Agent", "ACL 付与時間"];
const PRELUDE = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $env:PSModulePath=\"$env:USERPROFILE\\Documents\\WindowsPowerShell\\Modules;$env:ProgramFiles\\WindowsPowerShell\\Modules;$PSHOME\\Modules\"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";
const psArgs = (script: string): string[] => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(`${PRELUDE} ${script}`, "utf16le").toString("base64")];
const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value);

interface Options { project: string; otherProject: string; measureProject: string; output: string; runCli: boolean; keep: boolean; cleanup?: string }
export function parseTokenOptions(args: string[]): Options {
  const result: Options = { project: "E:\\dev\\clodex-token-test", otherProject: REPOSITORY, measureProject: REPOSITORY, output: join(REPOSITORY, "docs", "spikes", "sandbox-token.md"), runCli: false, keep: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--run-cli") { result.runCli = true; continue; }
    if (arg === "--keep") { result.keep = true; continue; }
    const keys = { "--project": "project", "--other-project": "otherProject", "--measure-project": "measureProject", "--output": "output", "--cleanup": "cleanup" } as const;
    if (!arg || !(arg in keys)) throw new Error(`不明な引数: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} の値が必要`);
    result[keys[arg as keyof typeof keys]] = value;
  }
  return result;
}

export function createRestrictingSid(): string {
  const bytes = randomBytes(16);
  return `S-1-5-21-${[0, 4, 8, 12].map(offset => bytes.readUInt32LE(offset)).join("-")}`;
}

export function validateAclTarget(path: string, home: string): void {
  const normalized = win32.resolve(path);
  const relative = win32.relative(normalized, home);
  if (!/^[a-z]:\\/i.test(path) || normalized === win32.parse(normalized).root || relative === "" || (!relative.startsWith("..") && !win32.isAbsolute(relative))) throw new Error(`ACL 対象外: ${path}`);
}

export const tokenHelperSource = String.raw`
using System;
using System.Linq;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Collections.Generic;
public static class TokenLauncher {
  const uint WRITE_RESTRICTED=0x8, TOKEN_ASSIGN_PRIMARY=1, TOKEN_DUPLICATE=2, TOKEN_QUERY=8, TOKEN_ADJUST_DEFAULT=0x80, SE_GROUP_LOGON_ID=0xc0000000;
  const int TOKEN_GROUPS=2, TOKEN_DEFAULT_DACL=6, TOKEN_RESTRICTED_SIDS=11;
  const uint DUPLICATE_SAME_ACCESS=2, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000, RESUME_FAILED=0xffffffff;
  const int STARTF_USESTDHANDLES=0x100, CREATE_SUSPENDED=4, CREATE_NO_WINDOW=0x08000000, JOB_EXTENDED_LIMIT=9, STD_INPUT_HANDLE=-10;
  [StructLayout(LayoutKind.Sequential)] struct SidEntry { public IntPtr sid; public uint attributes; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show,reserved2; public IntPtr reservedPointer,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limit { public BasicLimit basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disabled,IntPtr disabledSids,uint privileges,IntPtr deletedPrivileges,uint count,[In] SidEntry[] restricting,out IntPtr result);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size,out int needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,int flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo result);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int index);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr process,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limit limit,int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation+": "+new Win32Exception(Marshal.GetLastWin32Error()).Message); }
  static string Quote(string value) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); } else { b.Append('\\',slashes); b.Append(c); } slashes=0; }
    b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
  }
  static List<Tuple<string,uint>> Groups(IntPtr token,int kind) {
    int size; GetTokenInformation(token,kind,IntPtr.Zero,0,out size);
    IntPtr buffer=Marshal.AllocHGlobal(size);
    try {
      Check(GetTokenInformation(token,kind,buffer,size,out size),"GetTokenInformation");
      int count=Marshal.ReadInt32(buffer); var result=new List<Tuple<string,uint>>();
      for(int i=0;i<count;i++) {
        var entry=(SidEntry)Marshal.PtrToStructure(IntPtr.Add(buffer,IntPtr.Size+i*Marshal.SizeOf(typeof(SidEntry))),typeof(SidEntry));
        result.Add(Tuple.Create(new SecurityIdentifier(entry.sid).Value,entry.attributes));
      }
      return result;
    } finally {Marshal.FreeHGlobal(buffer);}
  }
  static void SetDefaultDacl(IntPtr token,string restrictingSid) {
    string user; using(var identity=WindowsIdentity.GetCurrent()) user=identity.User.Value;
    var descriptor=new RawSecurityDescriptor("D:(A;;GA;;;"+user+")(A;;GA;;;"+restrictingSid+")(A;;GA;;;SY)");
    var bytes=new byte[descriptor.DiscretionaryAcl.BinaryLength]; descriptor.DiscretionaryAcl.GetBinaryForm(bytes,0);
    IntPtr acl=Marshal.AllocHGlobal(bytes.Length),info=Marshal.AllocHGlobal(IntPtr.Size);
    try {Marshal.Copy(bytes,0,acl,bytes.Length);Marshal.WriteIntPtr(info,acl);Check(SetTokenInformation(token,TOKEN_DEFAULT_DACL,info,IntPtr.Size),"SetTokenInformation default DACL");}
    finally {Marshal.FreeHGlobal(info);Marshal.FreeHGlobal(acl);}
  }
  public static int Main(string[] args) {
    try {
      using(var identity=WindowsIdentity.GetCurrent()) {
        if(args.Length==1 && args[0]=="--inspect") { Console.WriteLine("{\"sid\":\""+identity.User.Value+"\",\"restricted\":"+IsTokenRestricted(identity.Token).ToString().ToLowerInvariant()+",\"restrictingSids\":["+String.Join(",",Groups(identity.Token,TOKEN_RESTRICTED_SIDS).Select(group=>"\""+group.Item1+"\""))+ "]}"); return 0; }
        if(new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new Exception("elevated token rejected");
      }
      if(args.Length<4) throw new ArgumentException("sid cwd timeout application [arguments]");
      return Run(args[0],args[1],UInt32.Parse(args[2]),args[3],args.Skip(4).ToArray());
    } catch(Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
  }
  static int Run(string sidText,string cwd,uint timeout,string app,string[] args) {
    IntPtr original=IntPtr.Zero,restricted=IntPtr.Zero,job=IntPtr.Zero;
    var allocatedSids=new List<IntPtr>();
    var handles=new IntPtr[3]; var info=new ProcessInfo();
    try {
      Check(OpenProcessToken(GetCurrentProcess(),TOKEN_ASSIGN_PRIMARY|TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ADJUST_DEFAULT,out original),"OpenProcessToken");
      if(IsTokenRestricted(original)) throw new Exception("caller already restricted; SID intersection requires separate investigation");
      string mode=Environment.GetEnvironmentVariable("CLODEX_SPIKE_TOKEN_MODE")??"dacl";
      var sidTexts=new List<string>();sidTexts.Add(sidText);
      if(mode=="logon"||mode=="everyone") {
        var logon=Groups(original,TOKEN_GROUPS).Single(group=>(group.Item2&SE_GROUP_LOGON_ID)==SE_GROUP_LOGON_ID);
        sidTexts.Add(logon.Item1);
      }
      if(mode=="everyone")sidTexts.Add("S-1-1-0");
      var entries=new List<SidEntry>();
      foreach(string text in sidTexts){IntPtr sid;Check(ConvertStringSidToSid(text,out sid),"ConvertStringSidToSid");allocatedSids.Add(sid);var entry=new SidEntry();entry.sid=sid;entries.Add(entry);}
      Check(CreateRestrictedToken(original,WRITE_RESTRICTED,0,IntPtr.Zero,0,IntPtr.Zero,(uint)entries.Count,entries.ToArray(),out restricted),"CreateRestrictedToken");
      SetDefaultDacl(restricted,sidText);
      for(int i=0;i<handles.Length;i++) Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(STD_INPUT_HANDLE-i),GetCurrentProcess(),out handles[i],0,true,DUPLICATE_SAME_ACCESS),"DuplicateHandle");
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"CreateJobObject");
      var limit=new Limit(); limit.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; Check(SetInformationJobObject(job,JOB_EXTENDED_LIMIT,ref limit,Marshal.SizeOf(limit)),"SetInformationJobObject");
      var startup=new Startup(); startup.cb=Marshal.SizeOf(startup); startup.flags=STARTF_USESTDHANDLES; startup.input=handles[0]; startup.output=handles[1]; startup.error=handles[2];
      var command=new StringBuilder(String.Join(" ",new[]{app}.Concat(args).Select(Quote)));
      Check(CreateProcessAsUser(restricted,app,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,cwd,ref startup,out info),"CreateProcessAsUser");
      if(!AssignProcessToJobObject(job,info.process)) { int error=Marshal.GetLastWin32Error(); TerminateProcess(info.process,1); throw new Win32Exception(error,"AssignProcessToJobObject"); }
      if(ResumeThread(info.thread)==RESUME_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread");
      if(WaitForSingleObject(info.process,timeout)!=0) throw new TimeoutException("restricted child timeout");
      uint code; Check(GetExitCodeProcess(info.process,out code),"GetExitCodeProcess"); return (int)code;
    } finally {
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(info.thread!=IntPtr.Zero) CloseHandle(info.thread); if(info.process!=IntPtr.Zero) CloseHandle(info.process);
      foreach(var handle in handles) if(handle!=IntPtr.Zero) CloseHandle(handle);
      if(restricted!=IntPtr.Zero) CloseHandle(restricted); if(original!=IntPtr.Zero) CloseHandle(original); foreach(IntPtr sid in allocatedSids) LocalFree(sid);
    }
  }
}
`;

interface Result { code: number | null; stdout: string; stderr: string; elapsedMs: number }
async function collect(child: ChildProcessWithoutNullStreams, input?: string, timeout = TIMEOUT_MS): Promise<Result> {
  const started = performance.now();
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  if (input) child.stdin.write(input);
  try {
    return await new Promise<Result>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`タイムアウト: ${stderr}`)), timeout);
      child.once("error", error => { clearTimeout(timer); fail(error); });
      child.once("close", code => { clearTimeout(timer); done({ code, stdout, stderr, elapsedMs: Math.round(performance.now() - started) }); });
    });
  } finally { child.kill(); }
}

function launch(command: string, args: string[], cwd: string, env = process.env): ChildProcessWithoutNullStreams {
  return spawn(command, args, { cwd, env: subscriptionEnv(env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}
async function host(script: string): Promise<Result> { return collect(launch(POWERSHELL, psArgs(script), REPOSITORY)); }
function requireSuccess(result: Result): string {
  if (result.code !== 0) throw new Error(JSON.stringify(result));
  return result.stdout.trim();
}

interface Manifest { sid: string; owner: string; targets: string[]; pending: string[]; cleaned: boolean }
function aclScript(path: string, sid: string, remove: boolean): string {
  return `$path=${psQuote(path)}; $acl=Get-Acl -LiteralPath $path; $sid=[Security.Principal.SecurityIdentifier]::new(${psQuote(sid)});
${remove ? `foreach($rule in $acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])) { if($rule.IdentityReference.Value -eq $sid.Value) { [void]$acl.RemoveAccessRuleSpecific($rule) } }` : `$item=Get-Item -LiteralPath $path -Force; $inherit=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify',$inherit,'None','Allow'));`}
Set-Acl -LiteralPath $path -AclObject $acl`;
}

async function assertNoReparse(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`reparse point は対象外: ${current}`);
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}

const probeWrite = (directory: string, leaf: string) => `$path=Join-Path ${psQuote(directory)} ${psQuote(leaf)}; $r=@{path=$path;created=$false;deleted=$false}; try { $s=[IO.File]::Open($path,'CreateNew','Write');$s.Dispose();$r.created=$true;[IO.File]::Delete($path);$r.deleted=$true } catch { $r.error=$_.Exception.GetBaseException().GetType().FullName; $r.reason=$_.Exception.GetBaseException().Message }; $r | ConvertTo-Json -Compress`;
const gitConfig = (project: string) => `-c user.name=ClodexSpike -c user.email=spike@example.invalid -c commit.gpgsign=false -c ${psQuote(`core.hooksPath=${join(project, "no-hooks")}`)}`;

async function main(): Promise<void> {
  if (process.argv.includes("--help")) { console.log("pnpm exec tsx spikes/sandbox-token.ts [--project E:\\dev\\clodex-token-test] [--keep] [--run-cli]\n--cleanup <manifest>: 記録した ACE を解除\n実 CLI は --run-cli 指定時のみ。--keep 以外は終了時に ACE を解除。"); return; }
  if (process.platform !== "win32") throw new Error("Windows 専用");
  const options = parseTokenOptions(process.argv.slice(2));
  const humanHome = homedir();
  const who = object(JSON.parse(requireSuccess(await host("$id=[Security.Principal.WindowsIdentity]::GetCurrent(); @{sid=$id.User.Value;admin=([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress"))));
  if (who.admin) throw new Error("管理者権限なしの実行が必要");
  const cleanup = async (manifest: Manifest, path: string) => {
    if (manifest.owner !== who.sid || !/^S-1-5-21-(\d+-){3}\d+$/.test(manifest.sid)) throw new Error("manifest の所有者または SID が不正");
    for (const target of [...manifest.pending]) {
      validateAclTarget(target, humanHome); await assertNoReparse(target);
      requireSuccess(await host(aclScript(target, manifest.sid, true)));
      manifest.pending = manifest.pending.filter(item => item !== target);
      await writeFile(path, JSON.stringify(manifest, null, 2));
    }
    manifest.cleaned = true; await writeFile(path, JSON.stringify(manifest, null, 2));
  };
  if (options.cleanup) { await cleanup(JSON.parse(await readFile(options.cleanup, "utf8")) as Manifest, options.cleanup); console.log("ACE 解除完了"); return; }
  for (const path of [options.project, options.measureProject]) validateAclTarget(path, humanHome);
  const overlaps = (left: string, right: string) => { const relative = win32.relative(left, right); return relative === "" || (!relative.startsWith("..") && !win32.isAbsolute(relative)); };
  if (overlaps(options.project, options.otherProject) || overlaps(options.otherProject, options.project)) throw new Error("計測専用 project と別 project を分離する必要あり");
  const runId = randomUUID();
  const sid = createRestrictingSid();
  const clodex = join(humanHome, ".clodex");
  const artifacts = join(clodex, "artifacts", `sandbox-token-${runId}`);
  const work = join(options.project, `run-${runId}`);
  const temporary = join(work, "temp");
  for (const directory of [work, artifacts, temporary]) await mkdir(directory, { recursive: true });
  const helper = join(work, "token-helper.exe");
  const source = join(work, "token-helper.cs");
  await writeFile(source, tokenHelperSource);
  const compile = await collect(launch(join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), ["/nologo", "/target:exe", "/platform:x64", `/out:${helper}`, source], work));
  requireSuccess(compile);
  const manifest: Manifest = { sid, owner: String(who.sid), targets: [], pending: [], cleaned: false };
  const manifestPath = join(clodex, `sandbox-token-${runId}.json`);
  const rows: Array<{ number: number; name: string; status: string; detail: string }> = [];
  const logs: string[] = [`日時: ${new Date().toISOString()}\nOS: ${process.platform} / Node ${process.version}\n人の SID: ${who.sid}\nrestricting SID: ${sid}\nproject: ${options.project}\n作業先: ${work}\nmanifest: ${manifestPath}\n--run-cli: ${options.runCli}`];
  const add = (number: number, status: string, detail: string) => { rows.push({ number, name: LABELS[number - 1]!, status, detail }); console.log(`#${number} ${status}: ${detail.slice(0, 250)}`); };
  const log = (title: string, value: unknown) => logs.push(`### ${title}\n\n\`\`\`text\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n\`\`\``);
  const grant = async (target: string) => {
    validateAclTarget(target, humanHome); await assertNoReparse(target);
    if (!manifest.targets.includes(target)) manifest.targets.push(target);
    if (!manifest.pending.includes(target)) manifest.pending.push(target);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const result = await host(aclScript(target, sid, false)); requireSuccess(result); return result.elapsedMs;
  };
  const env = { ...process.env, TEMP: temporary, TMP: temporary };
  let tokenMode = "dacl";
  const restrictedSpawn = (command: string, args: string[], cwd = work) => launch(helper, [sid, cwd, String(TURN_TIMEOUT_MS), command, ...args], cwd, { ...env, CLODEX_SPIKE_TOKEN_MODE: tokenMode });
  const restricted = (script: string, input?: string) => collect(restrictedSpawn(POWERSHELL, psArgs(script)), input);
  const measure = async (number: number, action: () => Promise<string>) => { try { add(number, "計測済み", await action()); } catch (error) { add(number, "失敗", errorText(error)); log(`#${number} エラー`, errorText(error)); } };
  try {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    log("既存 ACL（変更前）", await host(`foreach($p in @(${[humanHome, join(REPOSITORY, "spikes")].map(psQuote).join(",")})) { & icacls.exe $p }`));
    log("親トークン", await collect(launch(helper, ["--inspect"], work)));
    const allowed = [options.project, artifacts, join(humanHome, ".claude"), join(humanHome, ".claude.json"), join(humanHome, ".codex")];
    for (const path of allowed) {
      if (await lstat(path).then(() => true, () => false)) log(`ACE 付与: ${path}`, `${await grant(path)} ms`);
      else log(`ACE 未付与: ${path}`, "未存在");
    }
    await measure(1, async () => {
      for (const mode of ["dacl", "logon", "everyone"]) {
        tokenMode = mode;
        const trial = await restricted(`& ${psQuote(helper)} --inspect`);
        log(`起動方式: ${mode}`, trial);
        if (trial.code === 0 && trial.stdout.includes('"restricted":true')) break;
      }
      log("以降の token mode", tokenMode);
      const result = await restricted(`& ${psQuote(helper)} --inspect; [Console]::WriteLine([Console]::ReadLine()); [Console]::Error.WriteLine('stderr-ok'); & ${psQuote(POWERSHELL)} ${psArgs(`& ${psQuote(helper)} --inspect; ${probeWrite(options.otherProject, `.clodex-token-child-${runId}`)}`).map(psQuote).join(" ")}`, "stdin-ok\n");
      log("起動・孫プロセス", result);
      const output = requireSuccess(result);
      if (!output.includes("stdin-ok") || !result.stderr.includes("stderr-ok")) throw new Error("stdio が不一致");
      return output;
    });
    await measure(2, async () => {
      const results: unknown[] = [];
      for (const path of [options.project, artifacts, temporary, ...allowed.slice(2), "E:\\", options.otherProject, humanHome, process.env.APPDATA!]) {
        const info = await lstat(path).catch(() => undefined); if (!info) continue;
        const script = info.isDirectory() ? probeWrite(path, `.clodex-token-${runId}`) : `try { $s=[IO.File]::Open(${psQuote(path)},'Open','Write');$s.Dispose();'書き込み用 open 成功（内容変更なし）' } catch { $_.Exception.GetBaseException().Message;exit 1 }`;
        results.push({ path, ...await restricted(script) });
      }
      for (const path of ["E:\\", options.otherProject, humanHome, process.env.APPDATA!]) {
        const file = join(path, `.clodex-token-existing-${runId}`);
        await writeFile(file, "human", { flag: "wx" });
        try {
          results.push({ path: file, stage: "既存ファイルの変更・削除", ...await restricted(`$r=@{written=$false;deleted=$false};try{[IO.File]::WriteAllText(${psQuote(file)},'agent');$r.written=$true}catch{$r.writeError=$_.Exception.GetBaseException().Message};try{[IO.File]::Delete(${psQuote(file)});$r.deleted=$true}catch{$r.deleteError=$_.Exception.GetBaseException().Message};$r | ConvertTo-Json -Compress`) });
        } finally { await unlink(file).catch(error => { if (object(error).code !== "ENOENT") throw error; }); }
      }
      const fixture = join(clodex, `everyone-fixture-${runId}`);
      await mkdir(fixture);
      try {
        results.push({ path: fixture, stage: "Everyone 付与前", ...await restricted(probeWrite(fixture, "probe.txt")) });
        requireSuccess(await host(aclScript(fixture, "S-1-1-0", false)));
        results.push({ path: fixture, stage: "Everyone Modify 付与後", ...await restricted(probeWrite(fixture, "probe.txt")) });
      } finally { requireSuccess(await host(aclScript(fixture, "S-1-1-0", true))); }
      log("書き込み境界", results); return JSON.stringify(results);
    });
    await measure(3, async () => {
      const result = await restricted(`foreach($p in @(${[humanHome, options.otherProject, process.env.ProgramFiles!].map(psQuote).join(",")})) { try { $files=@(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop); @{path=$p;count=$files.Count;read=$true} | ConvertTo-Json -Compress } catch { @{path=$p;error=$_.Exception.Message} | ConvertTo-Json -Compress } }`);
      log("読み取り", result); return requireSuccess(result);
    });
    const gitDir = join(work, "git"); await mkdir(gitDir);
    await measure(4, async () => {
      const results: unknown[] = [];
      for (const command of ["node", "pnpm", "git", "claude", "codex"]) results.push({ command, ...await restricted(`& ${psQuote(command)} --version; exit $LASTEXITCODE`) });
      await writeFile(join(gitDir, "package.json"), JSON.stringify({ name: "clodex-token-spike", private: true, dependencies: { "is-number": "7.0.0" } }));
      results.push({ command: "pnpm install --ignore-scripts", ...await restricted(`Set-Location -LiteralPath ${psQuote(gitDir)}; & pnpm install --ignore-scripts;exit $LASTEXITCODE`) });
      results.push({ command: "git init/status/commit", ...await restricted(`Set-Location -LiteralPath ${psQuote(gitDir)}; & git init; if($LASTEXITCODE){exit $LASTEXITCODE}; & git status --short; if($LASTEXITCODE){exit $LASTEXITCODE}; & git ${gitConfig(gitDir)} commit --allow-empty -m sandbox-token-agent;exit $LASTEXITCODE`) });
      log("ツール", results); return JSON.stringify(results);
    });
    await measure(5, async () => {
      const key = `Software\\ClodexTokenSpike-${runId}`;
      try {
        const result = await restricted(`try { $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${psQuote(key)}); $k.SetValue('probe','test');$k.Dispose();'HKCU 書き込み成功' } catch { $_.Exception.GetBaseException().GetType().FullName; $_.Exception.GetBaseException().Message;exit 1 }`);
        log("HKCU", result); return JSON.stringify(result);
      } finally { requireSuccess(await host(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${psQuote(key)},$false)`)); }
    });
    await measure(6, async () => {
      const results = [
        { command: "git ls-remote", ...await restricted("& git ls-remote https://github.com/openai/codex.git HEAD;exit $LASTEXITCODE") },
        { command: "pnpm view", ...await restricted("& pnpm view is-number version;exit $LASTEXITCODE") },
        { command: "pnpm view（project 内 cache）", ...await restricted(`$env:npm_config_cache=${psQuote(join(work, "npm-cache"))}; & pnpm view is-number version;exit $LASTEXITCODE`) },
        { command: "HTTPS", ...await restricted("$r=Invoke-WebRequest -UseBasicParsing -Uri 'https://registry.npmjs.org/is-number/latest';$r.StatusCode") },
        { command: "HTTPS（Node）", ...await collect(restrictedSpawn(process.execPath, ["-e", "fetch('https://registry.npmjs.org/is-number/latest').then(async r=>{console.log(r.status);await r.arrayBuffer();if(!r.ok)process.exitCode=1}).catch(e=>{console.error(e);process.exitCode=1})"])) },
      ]; log("ネットワーク", results); return JSON.stringify(results);
    });
    await measure(7, async () => {
      const child = restrictedSpawn(POWERSHELL, psArgs(`$child=Start-Process -FilePath ${psQuote(POWERSHELL)} -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep 120') -PassThru; [Console]::WriteLine("$PID,$($child.Id)");Start-Sleep 120`));
      try {
        const pids = await new Promise<string[]>((done, fail) => {
          let text = ""; const timer = setTimeout(() => fail(new Error("PID 取得タイムアウト")), TIMEOUT_MS);
          child.stdout.on("data", (data: Buffer) => { text += data.toString(); const match = text.match(/(\d+),(\d+)/); if(match){clearTimeout(timer);done([match[1]!,match[2]!]);} });
          child.once("error", error => { clearTimeout(timer); fail(error); });
          child.once("exit", () => { clearTimeout(timer); fail(new Error("停止対象が早期終了")); });
        });
        const result = await collect(launch("taskkill.exe", ["/PID", pids[0]!, "/T", "/F"], work));
        const alive = await host(`Start-Sleep -Milliseconds 500; @(${pids.join(",")}) | ForEach-Object {@{pid=$_;alive=($null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue))}} | ConvertTo-Json -Compress`);
        log("停止", { result, alive }); return JSON.stringify({ result, alive });
      } finally { child.kill(); }
    });
    await measure(8, async () => {
      const file = join(work, `owner-${runId}.txt`);
      const created = await restricted(`[IO.File]::WriteAllText(${psQuote(file)},'token')`);
      const result = await host(`(Get-Acl -LiteralPath ${psQuote(file)}).GetOwner([Security.Principal.SecurityIdentifier]).Value; Set-Location -LiteralPath ${psQuote(gitDir)}; & git status --short; & git ${gitConfig(gitDir)} commit --allow-empty -m sandbox-token-human;exit $LASTEXITCODE`);
      log("所有者", { created, result }); return JSON.stringify({ created, result });
    });
    await measure(9, async () => {
      let received = false;
      const server = new McpServer({ name: "sandbox-token", version: "1" });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const http = createServer((req, res) => { received = true; void transport.handleRequest(req, res).catch(error => { res.writeHead(500).end(errorText(error)); }); });
      await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
      try {
        const address = http.address(); if (!address || typeof address === "string") throw new Error("ポートなし");
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sandbox-token", version: "1" } } });
        const result = await restricted(`Invoke-RestMethod -Uri 'http://127.0.0.1:${address.port}' -Method Post -ContentType 'application/json' -Headers @{Accept='application/json, text/event-stream'} -Body ${psQuote(body)} | ConvertTo-Json -Depth 10 -Compress`);
        log("MCP", { received, result }); return JSON.stringify({ received, result });
      } finally { await transport.close(); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); }
    });
    if (!options.runCli) add(10, "未実行", "--run-cli なし");
    else await measure(10, async () => {
      const agentSpawn: SpawnAgentProcess = (command, args, { cwd }) => {
        const child = restrictedSpawn(POWERSHELL, psArgs(`Set-Location -LiteralPath ${psQuote(cwd)}; & ${psQuote(command)} ${args.map(psQuote).join(" ")};exit $LASTEXITCODE`), cwd);
        const lines = createInterface({ input: child.stdout }); child.stderr.resume(); child.stdin.on("error", () => {});
        const spawned = new Promise<void>((done, fail) => {child.once("spawn",done);child.once("error",fail);}); void spawned.catch(() => {});
        return { spawned, write: text => { child.stdin.write(`${text}\n`); }, onLine: handler => {lines.on("line",handler);}, onExit: handler => {child.once("exit",handler);}, kill: () => {child.kill();} };
      };
      const results: unknown[] = [];
      for (const agent of [new ClaudeAdapter(agentSpawn), new CodexAdapter(agentSpawn)]) {
        try { await agent.setPermission("full"); await agent.start({ cwd: work }); results.push({agent:agent.id, result:await agent.send(`Write SANDBOX_TOKEN to ${JSON.stringify(join(work, `${agent.id}.txt`))} and ${JSON.stringify(join(options.otherProject, `.clodex-token-${runId}-${agent.id}`))}. Attempt both once and report errors. Do not elevate or change permissions.`)}); }
        finally { await agent.stop(); await unlink(join(options.otherProject, `.clodex-token-${runId}-${agent.id}`)).catch(error => { if(object(error).code!=="ENOENT") throw error; }); }
      }
      results.push(await collect(restrictedSpawn(process.execPath, ["-e", `const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage();await p.setContent('<h1>Sandbox token</h1>');await p.screenshot({path:${JSON.stringify(join(artifacts,"playwright.png"))}});await b.close()})().catch(e=>{console.error(e);process.exitCode=1})`])));
      log("実 Agent", results); return JSON.stringify(results);
    });
    await measure(11, async () => {
      const before = requireSuccess(await host(`(Get-Acl -LiteralPath ${psQuote(options.measureProject)}).Sddl`));
      const milliseconds = await grant(options.measureProject);
      const removed = await host(aclScript(options.measureProject, sid, true)); requireSuccess(removed);
      manifest.pending = manifest.pending.filter(target => target !== options.measureProject);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      const after = requireSuccess(await host(`(Get-Acl -LiteralPath ${psQuote(options.measureProject)}).Sddl`));
      const result = { path: options.measureProject, addMs: milliseconds, removeMs: removed.elapsedMs, rootSddlRestored: before === after, before, after };
      log("ACL 時間", result); return JSON.stringify(result);
    });
  } catch (error) { log("実行エラー", errorText(error)); process.exitCode = 1; }
  finally {
    if (!options.keep) {
      try {
        await cleanup(manifest, manifestPath);
        log("後片付け", requireSuccess(await host(`foreach($p in @(${manifest.targets.map(psQuote).join(",")})) { $rules=@((Get-Acl -LiteralPath $p).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -eq ${psQuote(sid)}}); @{path=$p;remaining=$rules.Count} | ConvertTo-Json -Compress }`)));
      }
      catch (error) { log("後片付け失敗", errorText(error)); process.exitCode = 1; }
    } else log("ACL 保持", `pnpm exec tsx spikes/sandbox-token.ts --cleanup ${JSON.stringify(manifestPath)}`);
    await writeFile(options.output, `# Spike L — write-restricted token\n\n${formatTable(rows)}\n\n${logs.join("\n\n")}\n`);
    console.log(`記録: ${options.output}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
