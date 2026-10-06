import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync, unlinkSync } from "node:fs";
import { appendFile, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ClaudeAdapter } from "../src/agents/claude-adapter.js";
import { CodexAdapter } from "../src/agents/codex-adapter.js";
import { fetchStartupProbe } from "../src/agents/startup-probe.js";
import type { AgentProcess, SpawnAgentProcess } from "../src/agents/agent-process.js";

const ACCOUNT = "clodex-agent";
const TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;
const HEARTBEAT_MS = 10_000;
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const API_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
const LABELS = ["stdio 起動", "書き込み境界", "読み取り境界", "ツール解決", "認証", "フル権限", "MCP", "停止", "所有者", "artifacts"];
export const psQuote = (text: string): string => `'${text.replaceAll("'", "''")}'`;
const encode = (script: string): string => Buffer.from(script, "utf16le").toString("base64");
const psArgs = (script: string): string[] => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode(`$ProgressPreference='SilentlyContinue'; ${script}`)];
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const within = (child: string, parent: string): boolean => {
  const relative = win32.relative(parent, child);
  return relative === "" || (!relative.startsWith("..\\") && relative !== ".." && !win32.isAbsolute(relative));
};

interface Options { project: string; otherProject: string; runCli: boolean }
export function parseOptions(args: string[]): Options {
  let project = "", otherProject = "", runCli = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--run-cli") { runCli = true; continue; }
    if (arg !== "--project" && arg !== "--other-project") throw new Error(`不明な引数: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} の値が必要`);
    if (arg === "--project") project = value; else otherProject = value;
  }
  if (!project || !otherProject) throw new Error("--project と --other-project が必要");
  return { project, otherProject, runCli };
}

export function validateTargets(project: string, other: string, repository: string, humanHome: string): void {
  for (const path of [project, other]) {
    if (!win32.isAbsolute(path) || path.startsWith("\\\\") || win32.parse(path).root === win32.normalize(path)) throw new Error("ローカルの専用ディレクトリが必要");
  }
  for (const protectedPath of [other, repository, humanHome]) {
    if (within(project, protectedPath) || within(protectedPath, project)) throw new Error(`project の範囲が不正: ${project}`);
  }
}

interface Row { number: number; name: string; status: string; detail: string }
export function formatTable(rows: Row[]): string {
  const cell = (text: string) => text.replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
  return ["| # | 項目 | 結果 | 詳細 |", "|---|---|---|---|", ...rows.map(r => `| ${r.number} | ${cell(r.name)} | ${cell(r.status)} | ${cell(r.detail)} |`)].join("\n");
}

export function cliScript(command: string, args: readonly string[], cwd: string): string {
  return `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${API_KEYS.map(key => `[Environment]::SetEnvironmentVariable('${key}',$null,'Process')`).join("; ")}; Set-Location -LiteralPath ${psQuote(cwd)}; & ${psQuote(command)} ${args.map(psQuote).join(" ")}; exit $LASTEXITCODE`;
}

// 資格情報は人の DPAPI で復号し、子のコマンドラインやログには渡さない。
const credentialScript = (credential: string) => `$secret=Get-Content -LiteralPath ${psQuote(credential)} -Raw | ConvertTo-SecureString; $credential=[PSCredential]::new("$env:COMPUTERNAME\\${ACCOUNT}",$secret);`;

export const directHelper = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class SandboxLogon {
  const int STARTF_USESTDHANDLES=0x100, CREATE_SUSPENDED=4, CREATE_UNICODE_ENVIRONMENT=0x400, LOGON_WITH_PROFILE=1;
  const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION=9, STD_INPUT_HANDLE=-10;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000, DUPLICATE_SAME_ACCESS=2, TIMEOUT_MS=180000, RESUME_FAILED=0xffffffff;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show,reserved2; public IntPtr reservedPointer,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limit { public BasicLimit basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithLogonW(string user,string domain,string pass,int logon,string app,StringBuilder cmd,int flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limit limit,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr Copy(int n) { IntPtr result; Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(n),GetCurrentProcess(),out result,0,true,DUPLICATE_SAME_ACCESS)); return result; }
  public static int Run(string user,string domain,string password,string app,string arguments,string cwd) {
    IntPtr job=IntPtr.Zero;
    var handles=new IntPtr[3]; var info=new ProcessInfo();
    try {
      for(int i=0;i<handles.Length;i++) handles[i]=Copy(STD_INPUT_HANDLE-i);
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      var limit=new Limit(); limit.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; Check(SetInformationJobObject(job,JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,ref limit,Marshal.SizeOf(limit)));
      var start=new Startup(); start.cb=Marshal.SizeOf(start); start.flags=STARTF_USESTDHANDLES; start.input=handles[0]; start.output=handles[1]; start.error=handles[2];
      Check(CreateProcessWithLogonW(user,domain,password,LOGON_WITH_PROFILE,app,new StringBuilder("\""+app+"\" "+arguments),CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,IntPtr.Zero,cwd,ref start,out info));
      if(!AssignProcessToJobObject(job,info.process)) { int code=Marshal.GetLastWin32Error(); TerminateProcess(info.process,1); throw new Win32Exception(code); }
      if(ResumeThread(info.thread)==RESUME_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint wait=WaitForSingleObject(info.process,TIMEOUT_MS); if(wait!=0) throw new TimeoutException("helper timeout");
      uint exit; Check(GetExitCodeProcess(info.process,out exit)); return (int)exit;
    } finally {
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(info.thread!=IntPtr.Zero) CloseHandle(info.thread); if(info.process!=IntPtr.Zero) CloseHandle(info.process);
      foreach(var handle in handles) if(handle!=IntPtr.Zero) CloseHandle(handle);
    }
  }
}`;

export const brokerSource = String.raw`
const {connect}=require("node:net");
const {spawn,spawnSync}=require("node:child_process");
const {createInterface}=require("node:readline");
const {timingSafeEqual}=require("node:crypto");
const IDLE_TIMEOUT_MS=30000,KILL_TIMEOUT_MS=10000;
const [port,token]=process.argv.slice(1);
const socket=connect(Number(port),"127.0.0.1");
const children=new Map();
const send=value=>{if(!socket.destroyed)socket.write(JSON.stringify(value)+"\n")};
const kill=child=>{if(child.pid)spawnSync("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,timeout:KILL_TIMEOUT_MS,stdio:"ignore"})};
const cleanup=()=>{for(const child of children.values())kill(child);children.clear()};
socket.setTimeout(IDLE_TIMEOUT_MS,()=>socket.destroy());
socket.on("error",()=>{});
socket.on("close",()=>{cleanup();process.exit(0)});
socket.on("connect",()=>send({type:"hello",token,pid:process.pid}));
let authenticated=false;
createInterface({input:socket}).on("line",line=>{
  let m;try{m=JSON.parse(line)}catch{socket.destroy();return}
  if(!authenticated){
    const a=Buffer.from(String(m.token||"")),b=Buffer.from(token);
    if(m.type!=="welcome"||a.length!==b.length||!timingSafeEqual(a,b)){socket.destroy();return}
    authenticated=true;return;
  }
  if(m.type==="ping"){send({type:"pong"});return}
  if(m.type==="close"){cleanup();socket.end();return}
  if(m.type==="kill"){const c=children.get(m.id);if(c)kill(c);return}
  if(m.type==="write"){children.get(m.id)?.stdin.write(m.data);return}
  if(m.type!=="start"||!Number.isInteger(m.id)||children.has(m.id))return;
  const env={...process.env};
  for(const key of Object.keys(env))if(["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","OPENAI_API_KEY","CODEX_API_KEY"].includes(key.toUpperCase()))delete env[key];
  try{
    const c=spawn(m.command,m.args,{cwd:m.cwd,env,windowsHide:true,stdio:["pipe","pipe","pipe"]});children.set(m.id,c);
    c.stdin.on("error",()=>{});
    c.on("spawn",()=>send({id:m.id,type:"spawn",pid:c.pid}));
    c.stdout.on("data",data=>send({id:m.id,type:"stdout",data:data.toString("base64")}));
    c.stderr.on("data",data=>send({id:m.id,type:"stderr",data:data.toString("base64")}));
    c.on("error",error=>send({id:m.id,type:"error",message:error.message}));
    c.on("close",code=>{children.delete(m.id);send({id:m.id,type:"exit",code})});
  }catch(error){send({id:m.id,type:"error",message:error.message});send({id:m.id,type:"exit",code:null})}
});
`;

const resetTargetEnvironment = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.ComponentModel;
public static class TargetEnvironment {
  [DllImport("userenv.dll",SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr env,IntPtr token,bool inherit);
  [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr env);
  public static void Reset() {
    IntPtr env;
    using(var identity=WindowsIdentity.GetCurrent()) {
      if(!CreateEnvironmentBlock(out env,identity.Token,false)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      foreach(DictionaryEntry entry in Environment.GetEnvironmentVariables()) Environment.SetEnvironmentVariable((string)entry.Key,null);
      for(IntPtr p=env;;) {
        string value=Marshal.PtrToStringUni(p); if(String.IsNullOrEmpty(value)) break;
        int split=value.IndexOf('='); if(split>0) Environment.SetEnvironmentVariable(value.Substring(0,split),value.Substring(split+1));
        p=IntPtr.Add(p,(value.Length+1)*2);
      }
    } finally { DestroyEnvironmentBlock(env); }
  }
}
'@
[TargetEnvironment]::Reset();
`;

interface ProbeProcess {
  spawned: Promise<void>; events: EventEmitter; pid?: number;
  write(data: string): void; kill(): void;
}
type Launch = (script: string, cwd: string) => ProbeProcess;

function localProcess(command: string, args: string[], cwd: string): ProbeProcess {
  const events = new EventEmitter();
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const spawned = new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); });
  void spawned.catch(() => {});
  child.stdin.on("error", () => {});
  child.stdout.on("data", data => events.emit("stdout", data));
  child.stderr.on("data", data => events.emit("stderr", data));
  child.on("close", code => events.emit("exit", code));
  return { events, spawned, get pid() { return child.pid; }, write: data => { child.stdin.write(data); }, kill: () => { child.kill(); } };
}

async function collect(proc: ProbeProcess, input?: string, timeout = TIMEOUT_MS): Promise<{ stdout: string; stderr: string; code: number | null }> {
  let stdout = "", stderr = "";
  const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
  proc.events.on("stdout", (data: Buffer) => { stdout += outDecoder.write(data); });
  proc.events.on("stderr", (data: Buffer) => { stderr += errDecoder.write(data); });
  try {
    return await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`タイムアウト: ${stderr}`)), timeout);
      proc.events.once("exit", (code: number | null) => { clearTimeout(timer); done({ stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end(), code }); });
      proc.spawned.then(() => { if (input) proc.write(input); }, error => { clearTimeout(timer); fail(error); });
    });
  } finally { proc.kill(); }
}

function directLaunch(credential: string): Launch {
  return (script, cwd) => {
    const scriptPath = join(cwd, `.clodex-helper-${randomUUID()}.ps1`);
    // CreateProcessWithLogonW のコマンドライン上限に収め、stdin は計測対象に残す。
    writeFileSync(scriptPath, `\uFEFF$ProgressPreference='SilentlyContinue'; ${script}`, { flag: "wx" });
    let proc: ProbeProcess;
    try { proc = localProcess(POWERSHELL, psArgs(`$ErrorActionPreference='Stop'; ${credentialScript(credential)}
Add-Type -TypeDefinition @'
${directHelper}
'@
try { $code=[SandboxLogon]::Run('${ACCOUNT}',$env:COMPUTERNAME,$credential.GetNetworkCredential().Password,${psQuote(POWERSHELL)},${psQuote(`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`)},${psQuote(cwd)}); exit $code } finally { $secret.Dispose() }`), cwd); }
    catch (error) { unlinkSync(scriptPath); throw error; }
    proc.events.once("exit", () => {
      try { unlinkSync(scriptPath); }
      catch (error) { console.error(`helper ファイル残存: ${scriptPath}: ${errorText(error)}`); }
    });
    return proc;
  };
}

async function startBroker(project: string, credential: string, tokenPath: string): Promise<{ launch: Launch; close(): Promise<void> }> {
  const bootstrapPath = join(project, `.clodex-broker-${randomUUID()}.ps1`);
  const token = randomBytes(32).toString("hex");
  const secretFile = await collect(localProcess(POWERSHELL, psArgs(`$ErrorActionPreference='Stop'; $path=${psQuote(tokenPath)}; [IO.File]::WriteAllText($path,''); $acl=[Security.AccessControl.FileSecurity]::new(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')); Set-Acl -LiteralPath $path -AclObject $acl; [IO.File]::WriteAllText($path,[Console]::ReadLine())`), project), `${token}\n`);
  if (secretFile.code !== 0) throw new Error(`token ACL: ${secretFile.stderr}`);
  const server = createServer();
  const sockets = new Set<Socket>();
  let socket: Socket | undefined;
  let launcher: ProbeProcess | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const procs = new Map<number, { process: ProbeProcess; resolve(): void; reject(error: Error): void }>();
  let sequence = 0;
  const close = async () => {
    clearInterval(heartbeat);
    if (socket && !socket.destroyed) {
      socket.write(JSON.stringify({ type: "close" }) + "\n");
      await new Promise<void>(done => {
        const timer = setTimeout(done, TIMEOUT_MS);
        socket!.once("close", () => { clearTimeout(timer); done(); });
      });
    }
    for (const client of sockets) client.destroy();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    launcher?.kill();
    await unlink(tokenPath).catch(error => { if (record(error).code !== "ENOENT") throw error; });
    await unlink(bootstrapPath).catch(error => { if (record(error).code !== "ENOENT") throw error; });
  };
  try {
    const connected = new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("broker 接続タイムアウト")), TIMEOUT_MS);
      server.on("error", error => { clearTimeout(timer); fail(error); });
      server.on("connection", candidate => {
        sockets.add(candidate);
        candidate.setTimeout(TIMEOUT_MS, () => candidate.destroy());
        candidate.on("error", () => {});
        candidate.on("close", () => {
          sockets.delete(candidate);
          if (candidate !== socket) return;
          for (const entry of procs.values()) { entry.reject(new Error("broker 接続終了")); entry.process.events.emit("exit", null); }
          procs.clear();
        });
        createInterface({ input: candidate }).on("line", line => {
          let msg: Record<string, unknown>;
          try { msg = record(JSON.parse(line)); } catch { candidate.destroy(); return; }
          if (candidate !== socket) {
            const supplied = Buffer.from(typeof msg.token === "string" ? msg.token : "");
            if (socket || msg.type !== "hello" || supplied.length !== Buffer.byteLength(token) || !timingSafeEqual(supplied, Buffer.from(token))) { candidate.destroy(); return; }
            socket = candidate; clearTimeout(timer);
            candidate.write(JSON.stringify({ type: "welcome", token }) + "\n");
            done(); return;
          }
          const entry = procs.get(Number(msg.id));
          if (!entry) return;
          if (msg.type === "spawn") { entry.process.pid = Number(msg.pid); entry.resolve(); }
          if (msg.type === "error") entry.reject(new Error(String(msg.message)));
          if (msg.type === "stdout" || msg.type === "stderr") entry.process.events.emit(msg.type, Buffer.from(String(msg.data), "base64"));
          if (msg.type === "exit") { entry.process.events.emit("exit", msg.code); procs.delete(Number(msg.id)); }
        });
      });
    });
    void connected.catch(() => {});
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("broker ポートなし");
    // token は短い起動引数で渡し、共有するスクリプトや token ファイルの ACL を広げない。
    const evaluate = "eval(Buffer.from(process.argv.splice(1,1)[0],String.fromCharCode(98,97,115,101,54,52)).toString())";
    const bootstrap = `param([int]$Port,[string]$Token)\n$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${resetTargetEnvironment} & ${psQuote(process.execPath)} -e ${psQuote(evaluate)} ${Buffer.from(brokerSource).toString("base64")} $Port $Token; exit $LASTEXITCODE`;
    await writeFile(bootstrapPath, `\uFEFF${bootstrap}`, { flag: "wx" });
    const launchScript = `$ErrorActionPreference='Stop'; ${credentialScript(credential)} $token=Get-Content -LiteralPath ${psQuote(tokenPath)} -Raw; try { $p=Start-Process -FilePath ${psQuote(POWERSHELL)} -Credential $credential -LoadUserProfile -WorkingDirectory ${psQuote(project)} -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psQuote(`"${bootstrapPath}"`)},'-Port','${address.port}','-Token',$token) -PassThru; $p.WaitForExit(); exit $p.ExitCode } finally { $secret.Dispose() }`;
    launcher = localProcess(POWERSHELL, psArgs(launchScript), project);
    const launched = collect(launcher, undefined, TURN_TIMEOUT_MS * LABELS.length);
    void launched.catch(() => {});
    await Promise.race([connected, launched.then(result => { throw new Error(`broker 起動失敗: ${result.stderr}`); })]);
    heartbeat = setInterval(() => socket?.write(JSON.stringify({ type: "ping" }) + "\n"), HEARTBEAT_MS);
    const launch: Launch = (script, cwd) => {
      if (!socket || socket.destroyed) throw new Error("broker 切断済み");
      const id = ++sequence;
      const events = new EventEmitter();
      let ready!: () => void, reject!: (error: Error) => void;
      const spawned = new Promise<void>((done, fail) => { ready = done; reject = fail; });
      void spawned.catch(() => {});
      const send = (type: string, data?: string) => socket?.write(JSON.stringify({ id, type, data }) + "\n");
      const proc: ProbeProcess = { spawned, events, write: data => { send("write", data); }, kill: () => { send("kill"); } };
      procs.set(id, { process: proc, resolve: ready, reject });
      socket.write(JSON.stringify({ type: "start", id, command: POWERSHELL, args: psArgs(script), cwd }) + "\n");
      return proc;
    };
    return { launch, close };
  } catch (error) { await close(); throw error; }
}

function asAgentSpawn(launch: Launch): SpawnAgentProcess {
  return (command, args, { cwd }): AgentProcess => {
    const proc = launch(cliScript(command, args, cwd), cwd);
    const lines = new EventEmitter();
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    proc.events.on("stdout", (data: Buffer) => {
      buffered += decoder.write(data);
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) { const line = buffered.slice(0, end).replace(/\r$/, ""); buffered = buffered.slice(end + 1); lines.emit("line", line); }
    });
    return { spawned: proc.spawned, write: line => proc.write(`${line}\n`), onLine: handler => { lines.on("line", handler); }, onExit: handler => { proc.events.on("exit", handler); }, kill: () => proc.kill() };
  };
}

const psPrelude = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";
const writeProbe = (directory: string, leaf: string, keep = false): string => `${psPrelude}
$path=Join-Path ${psQuote(directory)} ${psQuote(leaf)}; $created=$false; $result=@{path=$path;created=$false;deleted=$false};
try { $s=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write); $created=$true; $s.Dispose(); $result.created=$true } catch { $result.error=$_.Exception.GetType().FullName; $result.reason=$_.Exception.Message }
finally { if($created -and ${keep ? "$false" : "$true"}) { try { [IO.File]::Delete($path); $result.deleted=$true } catch { $result.cleanup=$_.Exception.Message } } }; $result | ConvertTo-Json -Compress`;
const readProbe = (path: string): string => `${psPrelude}
$path=${psQuote(path)}; $result=@{path=$path};
try { $item=Get-Item -LiteralPath $path -Force; if($item.PSIsContainer) { $entries=@(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop); $result.list=$true; $file=$entries | Where-Object {-not $_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)} | Select-Object -First 1; if($file) { $s=[IO.File]::OpenRead($file.FullName); $s.Dispose(); $result.open=$true } } else { $s=[IO.File]::OpenRead($path); $s.Dispose(); $result.open=$true } } catch { $result.error=$_.Exception.GetType().FullName; $result.reason=$_.Exception.Message }; $result | ConvertTo-Json -Compress`;

async function noReparse(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`reparse point は指定不可: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function deadline<T>(promise: Promise<T>, timeout = TURN_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error("タイムアウト")), timeout); })]); }
  finally { clearTimeout(timer); }
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    console.log("pnpm exec tsx spikes/sandbox-user.ts --project E:\\dev\\clodex-sandbox-test --other-project E:\\dev\\Clodex [--run-cli]\n--run-cli: 人の了承後のみ指定。#5 の認証照会、#6・#7 で各 Agent 2 ターン。\nセットアップした人のユーザーで非管理者実行。記録は ~/.clodex/sandbox-user-<id>.md。\n#9 の検証用 repository は project 内に保持。");
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  if (process.platform !== "win32") throw new Error("Windows 専用");
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const humanHome = homedir();
  validateTargets(options.project, options.otherProject, repository, humanHome);
  const clodexDir = join(humanHome, ".clodex");
  const credential = join(clodexDir, "agent-credential");
  const state = record(JSON.parse(await readFile(join(clodexDir, "sandbox-user-state.json"), "utf8")));
  if (state.complete !== true) throw new Error("セットアップ未完了");
  const artifacts = String(state.artifacts);
  if (win32.resolve(String(state.project)).toLowerCase() !== win32.resolve(options.project).toLowerCase()) throw new Error("setup と project が不一致");
  if (!within(artifacts, join(clodexDir, "artifacts")) || win32.resolve(artifacts).toLowerCase() === win32.resolve(join(clodexDir, "artifacts")).toLowerCase()) throw new Error("artifacts の範囲が不正");
  for (const path of [options.project, options.otherProject, artifacts, credential]) await noReparse(path);
  const identity = await collect(localProcess(POWERSHELL, psArgs(`${psPrelude} $id=[Security.Principal.WindowsIdentity]::GetCurrent(); @{sid=$id.User.Value;admin=([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress`), options.project));
  const human = record(JSON.parse(identity.stdout));
  if (human.admin || human.sid !== state.humanSid) throw new Error("setup と同じ人のユーザーで、管理者権限なしの実行が必要");
  const runId = randomUUID();
  const rows: Row[] = [];
  const logs: string[] = [`実行日時: ${new Date().toISOString()}`, `project: ${options.project}`, `other-project: ${options.otherProject}`, `artifacts: ${artifacts}`, `CLI 許可: ${options.runCli}`];
  const add = (number: number, status: string, detail: string) => rows.push({ number, name: LABELS[number - 1]!, status, detail });
  const save = async () => {
    console.log(formatTable(rows));
    const output = join(clodexDir, `sandbox-user-${runId}.md`);
    await writeFile(output, `${formatTable(rows)}\n\n${logs.join("\n\n")}\n`, { flag: "wx" });
    console.log(`記録: ${output}`);
  };
  const host = (script: string) => collect(localProcess(POWERSHELL, psArgs(script), options.project));
  let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
  const echo = `${psPrelude} [Console]::WriteLine([Security.Principal.WindowsIdentity]::GetCurrent().User.Value); [Console]::WriteLine([Console]::ReadLine()); [Console]::Error.WriteLine('stderr-ok')`;
  const testLaunch = async (launch: Launch) => {
    const result = await collect(launch(echo, options.project), "stdin-ok\n");
    if (result.code !== 0 || !result.stdout.includes(String(state.agentSid)) || !result.stdout.includes("stdin-ok") || !result.stderr.includes("stderr-ok")) throw new Error(JSON.stringify(result));
    return "SID・stdin・stdout・stderr 一致";
  };
  try {
    const direct = directLaunch(credential);
    let directOk = false;
    try { add(1, "成功 (a)", await testLaunch(direct)); directOk = true; } catch (error) { add(1, "失敗 (a)", errorText(error)); }
    try { broker = await startBroker(options.project, credential, join(clodexDir, `sandbox-user-token-${runId}`)); add(1, "成功 (b)", await testLaunch(broker.launch)); }
    catch (error) { add(1, "失敗 (b)", errorText(error)); await broker?.close(); broker = undefined; }
    const launch = broker?.launch ?? (directOk ? direct : undefined);
    if (!launch) { for (let number = 2; number <= LABELS.length; number++) add(number, "未計測", "別ユーザー起動不可"); return; }
    logs.push(`採用方式: ${broker ? "(b) localhost broker" : "(a) CreateProcessWithLogonW"}`);
    const target = async (script: string) => {
      const result = await collect(launch(script, options.project));
      if (result.code !== 0) throw new Error(`exit=${result.code}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const measure = async (number: number, action: () => Promise<string>) => {
      console.log(`#${number} ${LABELS[number - 1]}`);
      try { add(number, "計測済み", await action()); } catch (error) { add(number, "失敗", errorText(error)); }
    };
    await measure(2, async () => {
      const acl = await host(`${psPrelude} Get-PSDrive -PSProvider FileSystem | ForEach-Object { & icacls.exe $_.Root }`);
      logs.push(`ドライブ ACL:\n\n\`\`\`text\n${acl.stdout}\n${acl.stderr}\n\`\`\``);
      const results: string[] = [];
      for (const path of [options.project, options.otherProject, "E:\\", humanHome, "C:\\Windows\\Temp", "C:\\ProgramData"]) results.push(await target(writeProbe(path, `.clodex-spike-${runId}`)));
      return results.join("\n");
    });
    await measure(3, async () => {
      const results: string[] = [];
      for (const path of [".ssh", ".claude", ".codex"].map(p => join(humanHome, p)).concat(process.env.APPDATA ?? join(humanHome, "AppData", "Roaming"))) results.push(await target(readProbe(path)));
      return results.join("\n");
    });
    await measure(4, async () => {
      const found = await target(`${psPrelude} $result=@{identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;profile=$env:USERPROFILE;path=$env:PATH;tools=@()}; foreach($name in @('node','pnpm','git','claude','codex')) { $cmd=Get-Command $name -ErrorAction SilentlyContinue; $result.tools+=@{name=$name;source=$cmd.Source} }; $result | ConvertTo-Json -Depth 5 -Compress`);
      const results = [found, await target(readProbe(join(process.env.APPDATA ?? join(humanHome, "AppData", "Roaming"), "npm")))];
      for (const command of ["node", "pnpm", "git", "claude", "codex"]) {
        try { results.push(`${command}: ${await target(cliScript(command, ["--version"], options.project))}`); }
        catch (error) { results.push(`${command}: ${errorText(error)}`); }
      }
      logs.push(`CLI・ツールの版:\n${results.join("\n")}`);
      return results.join("\n");
    });
    const agentSpawn = asAgentSpawn(launch);
    if (!options.runCli) { add(5, "未計測", "--run-cli なし"); add(6, "未計測", "--run-cli なし"); }
    else {
      await measure(5, async () => {
        const result = await fetchStartupProbe(options.project, agentSpawn, TIMEOUT_MS);
        return JSON.stringify({ models: { claude: result.models.claude.length, codex: result.models.codex.length }, usage: Object.keys(result.usage), subscription: "#6 で既存 Adapter の認証判定を実行" });
      });
      await measure(6, async () => {
        const results: string[] = [];
        for (const agent of [new ClaudeAdapter(agentSpawn), new CodexAdapter(agentSpawn)]) {
          const inside = join(options.project, `.clodex-cli-${agent.id}-${runId}`);
          const outside = join(options.otherProject, `.clodex-cli-${agent.id}-${runId}`);
          try {
            await agent.setPermission("full");
            await deadline(agent.start({ cwd: options.project }));
            const result = await deadline(agent.send(`Write exactly SANDBOX_SPIKE to both files using filesystem tools: ${JSON.stringify(inside)} and ${JSON.stringify(outside)}. Attempt both writes once. Report exact errors. Do not change permissions, retry with elevation, or modify any other file.`));
            const insideExists = await readFile(inside, "utf8").then(text => text === "SANDBOX_SPIKE" || text === "SANDBOX_SPIKE\n", () => false);
            const outsideExists = await lstat(outside).then(() => true, () => false);
            const osProbe = await target(writeProbe(options.otherProject, `.clodex-os-${agent.id}-${runId}`));
            results.push(JSON.stringify({ agent: agent.id, status: result.status, insideExists, outsideExists, osProbe, report: result.text }));
          } catch (error) { results.push(`${agent.id}: ${errorText(error)}`); }
          finally {
            await deadline(agent.stop(), TIMEOUT_MS).catch(error => { results.push(`停止: ${errorText(error)}`); });
            for (const path of [inside, outside]) await unlink(path).catch(error => { if (record(error).code !== "ENOENT") results.push(`残存: ${path}: ${errorText(error)}`); });
          }
        }
        return results.join("\n");
      });
    }
    await measure(7, async () => {
      const received = new Set<string>();
      const transports = new Set<StreamableHTTPServerTransport>();
      const http = createHttpServer((req, res) => {
        const mcp = new McpServer({ name: "sandbox-spike", version: "1" });
        mcp.registerTool("send_message", { description: "接続の計測。引数は不要" }, async () => {
          received.add(req.url ?? "");
          return { content: [{ type: "text", text: "pong" }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        transports.add(transport);
        res.on("close", () => { transports.delete(transport); void transport.close(); });
        void mcp.connect(transport).then(() => transport.handleRequest(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      });
      await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
      try {
        const address = http.address();
        if (!address || typeof address === "string") throw new Error("MCP ポートなし");
        const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sandbox-user", version: "1" } } });
        const response = await target(`${psPrelude} $r=Invoke-RestMethod -Uri 'http://127.0.0.1:${address.port}' -Method Post -ContentType 'application/json' -Headers @{Accept='application/json, text/event-stream'} -Body ${psQuote(request)}; $r | ConvertTo-Json -Depth 10 -Compress`);
        const results = [`別ユーザーから MCP initialize: ${response}`];
        if (!options.runCli) results.push("実 Agent の tool 呼び出し: 未計測 (--run-cli なし)");
        else for (const agent of [new ClaudeAdapter(agentSpawn), new CodexAdapter(agentSpawn)]) {
          try {
            await agent.setPermission("full");
            await deadline(agent.start({ cwd: options.project, mcpUrl: `http://127.0.0.1:${address.port}/${agent.id}` }));
            const result = await deadline(agent.send("Call the clodex send_message MCP tool exactly once with an empty object. Do not use other tools. Reply DONE."));
            results.push(JSON.stringify({ agent: agent.id, status: result.status, received: received.has(`/${agent.id}`) }));
          } catch (error) { results.push(`${agent.id}: ${errorText(error)}`); }
          finally { await deadline(agent.stop(), TIMEOUT_MS).catch(error => { results.push(`停止: ${errorText(error)}`); }); }
        }
        return results.join("\n");
      } finally { await Promise.all([...transports].map(transport => transport.close())); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); }
    });
    await measure(8, async () => {
      const tree = launch(`${psPrelude} $child=Start-Process -FilePath ${psQuote(POWERSHELL)} -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep 120') -PassThru; [Console]::WriteLine("$PID,$($child.Id)"); Start-Sleep 120`, options.project);
      try {
        const pids = await deadline(new Promise<number[]>((done, fail) => {
          let text = "";
          tree.events.on("stdout", (data: Buffer) => { text += data.toString(); const match = text.match(/(\d+),(\d+)/); if (match) done([Number(match[1]), Number(match[2])]); });
          tree.events.once("exit", () => fail(new Error("停止用プロセスが早期終了")));
          tree.spawned.catch(fail);
        }), TIMEOUT_MS);
        const killed = await collect(localProcess("taskkill.exe", ["/PID", String(pids[0]), "/T", "/F"], options.project));
        const check = `${psPrelude} Start-Sleep -Milliseconds 500; @(${pids.join(",")}) | ForEach-Object { @{pid=$_;alive=($null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue))} } | ConvertTo-Json -Compress`;
        const afterHuman = await target(check);
        tree.kill();
        const remaining = await target(check);
        return JSON.stringify({ humanTaskkill: killed, afterHuman, via: broker ? "broker" : "helper JobObject", afterFallback: remaining });
      } finally { tree.kill(); }
    });
    await measure(9, async () => {
      const leaf = `.clodex-owner-${runId}`;
      const path = join(options.project, leaf);
      const created = await target(writeProbe(options.project, leaf, true));
      const ownership = await host(`${psPrelude} (Get-Acl -LiteralPath ${psQuote(path)}).Owner`);
      const results = [created, `owner: ${ownership.stdout.trim()}`];
      try { await appendFile(path, "human-edit"); await unlink(path); results.push("人の編集・削除: 成功"); }
      catch (error) { results.push(`人の編集・削除: ${errorText(error)}`); }
      const gitDir = join(options.project, `.clodex-git-${runId}`);
      const git = `function Invoke-Git { & git @args; if($LASTEXITCODE -ne 0) { throw "git exit=$LASTEXITCODE" } };`;
      const config = `-c user.name=ClodexSpike -c user.email=spike@example.invalid -c commit.gpgsign=false -c ${psQuote(`core.hooksPath=${join(gitDir, "disabled-hooks")}`)}`;
      results.push(`専用ユーザー init/commit: ${await target(`${psPrelude} ${git} [void](New-Item -ItemType Directory -Path ${psQuote(gitDir)}); Set-Location -LiteralPath ${psQuote(gitDir)}; Invoke-Git init; Invoke-Git ${config} commit --allow-empty -m sandbox-agent-first`)}`);
      results.push(`人の status/commit: ${JSON.stringify(await host(`${psPrelude} ${git} Set-Location -LiteralPath ${psQuote(gitDir)}; Invoke-Git status --short; Invoke-Git ${config} commit --allow-empty -m sandbox-human`))}`);
      try { results.push(`専用ユーザー status/commit: ${await target(`${psPrelude} ${git} Set-Location -LiteralPath ${psQuote(gitDir)}; Invoke-Git status --short; Invoke-Git ${config} commit --allow-empty -m sandbox-agent`)}`); }
      catch (error) { results.push(errorText(error)); }
      results.push(`再確認: ${JSON.stringify(await host(`${psPrelude} ${git} Set-Location -LiteralPath ${psQuote(gitDir)}; Invoke-Git status --short; Invoke-Git ${config} commit --allow-empty -m sandbox-human-after`))}`);
      results.push(`検証用 repository 保持: ${gitDir}`);
      return results.join("\n");
    });
    await measure(10, async () => {
      const results = [await target(writeProbe(artifacts, `.clodex-artifacts-${runId}`))];
      for (const path of [join(clodexDir, "web-token"), credential, join(clodexDir, "sandbox-user-state.json")]) results.push(await target(readProbe(path)));
      return results.join("\n");
    });
  } finally {
    try { await broker?.close(); } catch (error) { logs.push(`後片付け失敗: ${errorText(error)}`); }
    await save();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
}
