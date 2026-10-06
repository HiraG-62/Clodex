import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { aclScript } from "./sandbox-token.js";
import { collect, startBroker, psQuote, formatTable } from "./sandbox-user.js";

const PROJECT = "E:\\dev\\clodex-hybrid-test";
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const TIMEOUT_MS = 90_000;
const PRELUDE = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$env:PSModulePath=\"$env:ProgramFiles\\WindowsPowerShell\\Modules;$PSHOME\\Modules\";";
const psArgs = (script: string) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(PRELUDE + script, "utf16le").toString("base64")];
interface Result { code: number | null; stdout: string; stderr: string }
interface State { agentSid: string; humanSid: string; artifacts: string }
export function hybridCommand(helper: string, sid: string, cwd: string, command: string, argv: string[]): string {
  return `$env:CLODEX_SPIKE_TOKEN_MODE='write-users'; & ${psQuote(helper)} ${[sid, cwd, String(TIMEOUT_MS), command, ...argv].map(psQuote).join(" ")};exit $LASTEXITCODE`;
}
async function local(command: string, args: string[]): Promise<Result> {
  const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(new Error("タイムアウト")); }, TIMEOUT_MS);
    child.once("error", error => { clearTimeout(timer); fail(error); });
    child.once("close", code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}
const host = (script: string) => local(POWERSHELL, psArgs(script));
const checked = (result: Result) => { if (result.code !== 0) throw new Error(JSON.stringify(result)); return result.stdout.trim(); };
async function noReparse(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`reparse point は対象外: ${current}`);
    if (dirname(current) === current) return;
  }
}

export async function runHybrid(state: State, helperSource: string, cleanupOnly = false): Promise<void> {
  const clodex = join(homedir(), ".clodex");
  const identity = JSON.parse(checked(await host("$id=[Security.Principal.WindowsIdentity]::GetCurrent();@{sid=$id.User.Value;admin=([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress"))) as { sid: string; admin: boolean };
  if (identity.admin || identity.sid !== state.humanSid) throw new Error("setup と同じ非管理者ユーザーが必要");
  await mkdir(PROJECT, { recursive: true });
  await noReparse(PROJECT);
  if (cleanupOnly) { checked(await host(aclScript(PROJECT, state.agentSid, true))); console.log("project の agent ACE 解除済み"); return; }
  const existing = JSON.parse(checked(await host(`@((Get-Acl -LiteralPath ${psQuote(PROJECT)}).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -eq ${psQuote(state.agentSid)}}).Count|ConvertTo-Json`))) as number;
  if (existing !== 0) throw new Error("新規 project に agent ACE が残存。監査と解除が必要");
  const runId = randomUUID();
  const work = join(PROJECT, `hybrid-${runId}`);
  await mkdir(work);
  const source = join(work, "token-helper.cs"), helper = join(work, "token-helper.exe");
  await writeFile(source, helperSource);
  checked(await local(join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), ["/nologo", "/target:exe", "/platform:x64", `/out:${helper}`, source]));
  const logs: Record<string, unknown> = { runId, date: new Date().toISOString(), project: PROJECT, work, state };
  const rows: Array<{ number: number; name: string; status: string; detail: string }> = [];
  const output = join(clodex, `sandbox-hybrid-${runId}.json`);
  let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
  let aclAttempted = false;
  const record = (number: number, name: string, result: unknown) => { logs[name] = result; rows.push({ number, name, status: "計測済み", detail: JSON.stringify(result).slice(0, 200) }); console.log(`#${number} ${name}`); };
  const before = checked(await host(`(Get-Acl -LiteralPath ${psQuote(PROJECT)}).Sddl`));
  try {
    logs.aclPending = PROJECT; await writeFile(output, JSON.stringify(logs, null, 2));
    aclAttempted = true;
    checked(await host(aclScript(PROJECT, state.agentSid, false)));
    broker = await startBroker(PROJECT, join(clodex, "agent-credential"), join(clodex, `sandbox-hybrid-token-${runId}`));
    const currentBroker = broker;
    const agent = (script: string, input?: string) => collect(currentBroker.launch(PRELUDE + script, work), input, TIMEOUT_MS);
    const restricted = (command: string, argv: string[], input?: string) => agent(hybridCommand(helper, state.agentSid, work, command, argv), input);
    const shell = (script: string, input?: string) => restricted(POWERSHELL, psArgs(script), input);
    const node = async (script: string) => {
      const path = join(work, `probe-${randomUUID()}.cjs`);
      await writeFile(path, script, { flag: "wx" });
      try { return await restricted(process.execPath, [path]); }
      finally { await unlink(path); }
    };
    const profile = checked(await agent("$env:USERPROFILE"));
    record(2, "起動", { broker: await agent(`& ${psQuote(helper)} --inspect`), child: await restricted(helper, ["--inspect"]), stdio: await shell(`[Console]::WriteLine([Console]::ReadLine());[Console]::Error.WriteLine('stderr-ok'); & ${psQuote(helper)} --inspect`, "stdin-ok\n"), profile });
    const boundary: unknown[] = [];
    for (const directory of [PROJECT, state.artifacts, profile, "E:\\", "E:\\dev\\Clodex", "D:\\", "C:\\Users\\Public", "C:\\ProgramData", "C:\\Windows\\Temp", homedir()]) {
      const file = join(directory, `.clodex-hybrid-${runId}`), existingFile = `${file}-existing`;
      try {
        const create = await restricted(helper, ["--boundary", file]);
        let seed: Result;
        try { await writeFile(existingFile, "human", { flag: "wx" }); seed = { code: 0, stdout: "human", stderr: "" }; }
        catch { seed = await agent(`[IO.File]::WriteAllText(${psQuote(existingFile)},'agent');'agent'`); }
        const remove = seed.code === 0 ? await restricted(helper, ["--delete", existingFile]) : undefined;
        boundary.push({ directory, residualDeny: directory === "D:\\", create, seed, remove });
      } finally {
        for (const target of [file, existingFile]) {
          try { await unlink(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") checked(await agent(`if([IO.File]::Exists(${psQuote(target)})){[IO.File]::Delete(${psQuote(target)})}`)); }
        }
      }
    }
    record(3, "Win32 書き込み・削除", boundary);
    const toolResults: unknown[] = [];
    for (const name of ["node", "pnpm", "git", "claude", "codex"]) toolResults.push({ name, result: await shell(`& ${psQuote(name)} --version;exit $LASTEXITCODE`) });
    toolResults.push({ name: "PowerShell 7", result: await restricted("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"])});
    toolResults.push({ name: "Node 子・孫", result: await node(`const {spawnSync}=require('child_process');const r=spawnSync(process.execPath,['-e',${JSON.stringify(`const r=require('child_process').spawnSync(${JSON.stringify(helper)},['--inspect'],{encoding:'utf8',windowsHide:true});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status??1`)}],{encoding:'utf8',windowsHide:true});console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message}));process.exitCode=r.status??1`) });
    toolResults.push({ name: "HKCU", result: await restricted(helper, ["--registry", `Software\\ClodexHybrid-${runId}`]) });
    checked(await agent(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\\ClodexHybrid-${runId}',$false)`));
    const gitDir = join(work, "git");
    checked(await agent(`[void][IO.Directory]::CreateDirectory(${psQuote(gitDir)});[IO.File]::WriteAllText(${psQuote(join(gitDir,"package.json"))},'{"name":"hybrid-spike","private":true,"dependencies":{"is-number":"7.0.0"}}')`));
    toolResults.push({ name: "pnpm install", result: await shell(`Set-Location ${psQuote(gitDir)};& pnpm install --ignore-scripts;exit $LASTEXITCODE`) });
    toolResults.push({ name: "git init/status/commit", result: await shell(`Set-Location ${psQuote(gitDir)};& git init;if($LASTEXITCODE){exit $LASTEXITCODE};& git status --short;if($LASTEXITCODE){exit $LASTEXITCODE};& git -c user.name=ClodexSpike -c user.email=spike@example.invalid -c commit.gpgsign=false -c ${psQuote(`core.hooksPath=${join(work,"no-hooks")}`)} commit --allow-empty -m hybrid-spike;exit $LASTEXITCODE`) });
    record(4, "ツール", toolResults);
    const network: unknown[] = [];
    for (const command of ["& git ls-remote https://github.com/openai/codex.git HEAD;exit $LASTEXITCODE", "& pnpm view is-number version;exit $LASTEXITCODE"]) network.push(await shell(command));
    network.push(await node("fetch('https://registry.npmjs.org/is-number/latest').then(async r=>{console.log(r.status);await r.arrayBuffer()}).catch(e=>{console.error(e);process.exitCode=1})"));
    const mcp = new McpServer({ name: "hybrid-spike", version: "1" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    const http = createServer((req,res) => { void transport.handleRequest(req,res).catch(()=>res.end()); });
    await new Promise<void>(done => http.listen(0,"127.0.0.1",done));
    try {
      const address = http.address(); if (!address || typeof address === "string") throw new Error("MCP ポートなし");
      const body = { jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"hybrid",version:"1"}} };
      network.push(await node(`fetch('http://127.0.0.1:${address.port}',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>console.log(await r.text())).catch(e=>{console.error(e);process.exitCode=1})`));
    } finally { await transport.close(); http.closeAllConnections(); await new Promise<void>(done=>http.close(()=>done())); }
    record(5, "ネットワーク・MCP", network);
    const tree = currentBroker.launch(PRELUDE + hybridCommand(helper,state.agentSid,work,POWERSHELL,psArgs(`$c=Start-Process -WindowStyle Hidden -FilePath ${psQuote(POWERSHELL)} -ArgumentList @('-NoProfile','-Command','Start-Sleep 60') -PassThru;[Console]::WriteLine("$PID,$($c.Id)");Start-Sleep 60`)),work);
    try {
      const pids = await new Promise<string[]>((done,fail)=>{let text="";const timer=setTimeout(()=>fail(new Error("PID 取得タイムアウト")),10_000);tree.events.on("stdout",(data:Buffer)=>{text+=data.toString();const match=text.match(/(\d+),(\d+)/);if(match){clearTimeout(timer);done([match[1]!,match[2]!]);}});tree.spawned.catch(error=>{clearTimeout(timer);fail(error);});});
      const humanKill = await local("taskkill.exe",["/PID",pids[0]!,"/T","/F"]);
      const check = `Start-Sleep -Milliseconds 500;@(${pids.join(",")})|ForEach-Object {@{pid=$_;alive=($null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue))}}|ConvertTo-Json -Compress`;
      const afterHuman = await agent(check);
      tree.kill();
      record(5,"停止",{humanKill,afterHuman,afterBrokerKill:await agent(check)});
    } finally { tree.kill(); }
    record(6,"ACL 追加", "新規 project の agent Modify のみ追加。artifacts は setup の既存 Allow。D: の Deny は変更なし");
  } catch (error) { logs.error=error instanceof Error?error.message:String(error); process.exitCode=1; }
  finally {
    try { await broker?.close(); } catch(error) { logs.brokerCleanupError=String(error);process.exitCode=1; }
    if (aclAttempted) {
      try {
        checked(await host(aclScript(PROJECT,state.agentSid,true)));
        logs.aclPending=null;
        const after=checked(await host(`(Get-Acl -LiteralPath ${psQuote(PROJECT)}).Sddl`));
        logs.aclCleanup={before,after,restored:before===after};
      } catch(error) { logs.aclCleanupError=String(error);process.exitCode=1; }
    }
    await writeFile(output,JSON.stringify(logs,null,2));console.log(formatTable(rows));console.log(`記録: ${output}`);
  }
}
