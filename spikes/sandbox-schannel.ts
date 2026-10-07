import { copyFile, mkdir, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";
import { brokerSource } from "../src/sandbox/broker-source.js";
import { nativeSource } from "../src/sandbox/native-source.js";
import { POWERSHELL, psArgs, psQuote, runHost } from "../src/sandbox/powershell.js";
import type { BrokerConnection } from "../src/sandbox/broker.js";

const TIMEOUT_MS = 30_000;
if (!nativeSource.includes("(uint)entries.Count,entries.ToArray(),out restricted")) throw new Error("この比較は通常の restricted token 版の helper が必要");
const TRACE_PDB_KEY = "3EDD48FFBFD3AE1FDDE522AB7C3F659D1";
async function account(broker: BrokerConnection, cwd: string): Promise<unknown> {
  const proc = broker.spawn("codex", ["app-server"], {cwd,env:{CLODEX_AGENT:"codex"}});
  try { return await new Promise(resolve => {
    let done=false;
    const timer = setTimeout(()=>finish({error:"timeout"}),TIMEOUT_MS);
    const finish = (value:unknown) => {if(done)return;done=true;clearTimeout(timer);resolve(value);};
    proc.onExit(code=>finish({exit:code}));
    proc.onLine(line=>{
      if(done)return;
      const m=JSON.parse(line) as {id?:number;error?:unknown;result?:{account?:{type?:string}}};
      if(m.id===1){proc.write(JSON.stringify({method:"initialized"}));proc.write(JSON.stringify({id:2,method:"account/read",params:{}}));}
      if(m.id===2)finish(m.error?{error:m.error}:{accountType:m.result?.account?.type??null});
    });
    proc.spawned.then(()=>proc.write(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"clodex",title:"Clodex",version:"0.0.0"},capabilities:null}}))).catch(error=>finish({error:String(error)}));
  }); } finally {proc.kill();}
}

const tls = String.raw`
try { $r=Invoke-WebRequest 'https://example.com' -UseBasicParsing -TimeoutSec 15; @{status=[int]$r.StatusCode}|ConvertTo-Json -Compress }
catch { $errors=@();$e=$_.Exception;while($e){$errors+=@{type=$e.GetType().FullName;message=$e.Message;hresult=('{0:X8}' -f $e.HResult)};$e=$e.InnerException};$errors|ConvertTo-Json -Compress }
`;

for (const mode of ["unrestricted", "restricted", "restricted-token-dacl", "filtered-no-sids"] as const) {
  if(process.argv.includes("--debug") && mode!=="restricted")continue;
  const platform = new WindowsSandboxPlatform(homedir(),"E:\\dev\\clodex-hybrid-test");
  let directory: string | undefined;
  const files = ["node.exe","token-helper.exe","environment.json","broker.cjs","schannel-probe.exe"];
  try {
    if(!await platform.inspect())throw new Error("セットアップ未完了");
    const original=await platform["runtime"]();
    directory=join(dirname(original),`schannel-${randomUUID()}`);
    await mkdir(directory);
    for(const file of files.slice(0,3))await copyFile(join(original,file),join(directory,file));
    await writeFile(join(directory,"broker.cjs"),mode==="unrestricted"?brokerSource.replace("spawn(helper,[sid,m.cwd,INFINITE_WAIT,command,...args]","spawn(command,args"):brokerSource);
    if(mode==="restricted-token-dacl" || mode==="filtered-no-sids"){
      const source=mode==="filtered-no-sids"?nativeSource.replace("(uint)entries.Count,entries.ToArray(),out restricted","0,new SidEntry[0],out restricted"):nativeSource.replace("SetDefaultDacl(restricted,sidText,logon.Item1);",String.raw`SetDefaultDacl(restricted,sidText,logon.Item1);
      var tokenDescriptor=new RawSecurityDescriptor("D:P(A;;GA;;;"+sidText+")(A;;GA;;;"+logon.Item1+")(A;;GA;;;SY)");
      var tokenBytes=new byte[tokenDescriptor.BinaryLength];tokenDescriptor.GetBinaryForm(tokenBytes,0);
      Check(SetKernelObjectSecurity(restricted,DACL_SECURITY_INFORMATION,tokenBytes),"restricted token DACL");`);
      files.push("token-helper.cs");await writeFile(join(directory,"token-helper.cs"),source);
      await runHost(`& 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe' /nologo /target:exe /reference:System.Web.Extensions.dll ${psQuote(`/out:${join(directory,"token-helper.exe")}`)} ${psQuote(join(directory,"token-helper.cs"))};if($LASTEXITCODE -ne 0){throw 'compile failed'}`);
    }
    await runHost(`& 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe' /nologo /target:exe ${psQuote(`/out:${join(directory,"schannel-probe.exe")}`)} ${psQuote(join(process.cwd(),"spikes","sandbox-schannel-native.cs"))};if($LASTEXITCODE -ne 0){throw 'compile failed'}`);
    const runtime=directory;
    Object.defineProperty(platform,"runtime",{value:async()=>runtime});
    await platform.connect(false);
    const broker=platform["broker"]!,profile=platform["identity"]!.profile;
    if(process.argv.includes("--debug")){
      const dll=await readFile("C:\\Windows\\System32\\sspicli.dll"),rsds=dll.indexOf(Buffer.from("RSDS")),guid=dll.subarray(rsds+4,rsds+20);
      if(rsds<0)throw new Error("sspicli のシンボル情報なし");
      const key=(guid.readUInt32LE(0).toString(16).padStart(8,"0")+guid.readUInt16LE(4).toString(16).padStart(4,"0")+guid.readUInt16LE(6).toString(16).padStart(4,"0")+guid.subarray(8).toString("hex")+dll.readUInt32LE(rsds+20).toString(16)).toUpperCase();
      if(process.argv.includes("--trace") && key!==TRACE_PDB_KEY)throw new Error("sspicli の版が異なるため命令位置の再確認が必要");
      const response=await fetch(`https://msdl.microsoft.com/download/symbols/sspicli.pdb/${key}/sspicli.pdb`,{signal:AbortSignal.timeout(TIMEOUT_MS)});
      if(!response.ok)throw new Error(`symbols: ${response.status}`);
      files.push("sspicli.pdb");await writeFile(join(directory,"sspicli.pdb"),Buffer.from(await response.arrayBuffer()));
      const index=process.argv.indexOf("--debug-command");
      const command=process.argv.includes("--trace")?[
        'bp sspicli!SspipAcquireCredentialsHandle+0xdf ".echo CHECK; r eax; gc"',
        'bp sspicli!SspipAcquireCredentialsHandle+0x274 ".echo RPC; r eax; k; gc"',
        "g",
      ].join("\n"):index<0?"uf sspicli!AcquireCredentialsHandleW+0x60":process.argv[index+1]!;
      files.push("debug.txt");await writeFile(join(directory,"debug.txt"),`sxe ld:sspicli\ng\n.reload /f sspicli.dll\n${command}\nq\n`);
      const output=await broker.run("C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",["-y",directory,"-o","-cf",join(directory,"debug.txt"),join(directory,"schannel-probe.exe")],profile,TIMEOUT_MS);
      await writeFile(join(process.cwd(),"spikes","sandbox-schannel-debug.log"),output);
      console.log("debug log: spikes/sandbox-schannel-debug.log");
      continue;
    }
    console.log(mode,"native",await broker.run(join(directory,"schannel-probe.exe"),[],profile,TIMEOUT_MS));
    console.log(mode,"account",JSON.stringify(await account(broker,profile)));
    console.log(mode,"powershell",await broker.run(POWERSHELL,psArgs(tls),profile,TIMEOUT_MS));
    try {console.log(mode,"curl",await broker.run("C:\\Windows\\System32\\curl.exe",["--head","--silent","--show-error","--max-time","15","https://example.com"],profile,TIMEOUT_MS));}
    catch(error){console.log(mode,"curl",error instanceof Error?error.message:String(error));}
  } finally {
    await platform.close();
    if(directory){for(const file of files)await unlink(join(directory,file));await rmdir(directory);}
  }
}
