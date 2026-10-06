import { copyFile, lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, win32 } from "node:path";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { fetchStartupProbe } from "../agents/startup-probe.js";
import { ensureSandboxSetup, setupComplete, type SetupStatus } from "./setup.js";
import { WindowsAccountSetup } from "./account-setup.js";
import { t } from "../i18n/i18n.js";
import type { SpawnAgentProcess } from "../agents/agent-process.js";
import { writeFileAtomic } from "../project/atomic-write.js";
import type { SandboxPlatform } from "./controller.js";
import { BrokerExitError, connectBroker, type BrokerConnection } from "./broker.js";
import { brokerSource } from "./broker-source.js";
import { buildAgentEnvironment } from "./environment.js";
import { nativeSource } from "./native-source.js";
import { POWERSHELL, psQuote, psArgs, runHost } from "./powershell.js";

const ACCOUNT = "clodex-agent";
const MAX_LOGON_COMMAND = 1024;
const CLEANUP_ATTEMPTS = 30;
const CLEANUP_INTERVAL = 100;
async function removeTemporary(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await unlink(path); return; }
    catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      if (error.code === "ENOENT") return;
      if ((error.code !== "EBUSY" && error.code !== "EPERM") || attempt >= CLEANUP_ATTEMPTS) throw error;
      await delay(CLEANUP_INTERVAL);
    }
  }
}
const ruleSchema = z.object({ rights: z.number(), inheritance: z.number(), propagation: z.number(), type: z.number() });
const aclSchema = z.object({ sddl: z.string(), rules: z.array(ruleSchema) });
const leaseSchema = z.object({ path: z.string(), before: aclSchema, after: aclSchema, gitHuman: z.boolean(), gitAgent: z.boolean() });
const journalSchema = z.object({ sid: z.string(), leases: z.array(leaseSchema) });
type Lease = z.infer<typeof leaseSchema>;
type Acl = z.infer<typeof aclSchema>;
const identitySchema = z.object({ humanSid: z.string(), agentSid: z.string(), profile: z.string(), machine: z.record(z.string(), z.string()) });
type Identity = z.infer<typeof identitySchema>;

export function validateSandboxPath(path: string, home: string): void {
  const normalized = win32.resolve(path);
  const relative = win32.relative(normalized, win32.resolve(home));
  if (!/^[A-Za-z]:\\/.test(path) || normalized === win32.parse(normalized).root || relative === "" || (!relative.startsWith("..") && !win32.isAbsolute(relative))) throw new Error(`ACL 対象外: ${path}`);
}

async function noReparse(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`reparse point は対象外: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

const aclPrelude = (path: string, sid: string) => `$path=${psQuote(path)}; $sid=[Security.Principal.SecurityIdentifier]::new(${psQuote(sid)}); $acl=[IO.Directory]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Access); function Snapshot($value) { @{sddl=$value.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);rules=@($value.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -eq $sid.Value} | ForEach-Object {@{rights=[int]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;type=[int]$_.AccessControlType}})} };`;
const ruleSignature = (acl: Acl) => JSON.stringify(acl.rules.map((rule) => JSON.stringify(rule)).sort());

export class WindowsSandboxPlatform implements SandboxPlatform {
  private static readonly setups = new Map<string, Promise<void>>();
  private identity: Identity | undefined;
  private broker: BrokerConnection | undefined;
  private runtimeDir: string | undefined;
  private leases: Lease[] = [];
  private journalPath: string;
  private readonly credentialPath: string;
  constructor(private readonly home: string, private readonly project: string, private readonly notice: (text: string) => void = () => {}) {
    const hash = createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0, 16);
    this.journalPath = join(home, ".clodex", `sandbox-project-${hash}.json`);
    this.credentialPath = join(home, ".clodex", "agent-credential");
  }
  readonly spawn: SpawnAgentProcess = (command, args, options) => {
    if (!this.broker) throw new Error("broker 未接続");
    return this.broker.spawn(command, args, options);
  };

  async inspect(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      await noReparse(this.credentialPath);
      const output = await runHost(`$human=[Security.Principal.WindowsIdentity]::GetCurrent(); if(([Security.Principal.WindowsPrincipal]::new($human)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw '非管理者実行が必要'}; $user=Get-LocalUser -Name '${ACCOUNT}'; if(-not $user.Enabled){throw 'ユーザー無効'}; $profile=(Get-ItemProperty -LiteralPath ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$user.SID.Value)).ProfileImagePath; $machine=[Environment]::GetEnvironmentVariables('Machine');$machine['SystemRoot']=[Environment]::GetFolderPath('Windows');$machine['ProgramFiles']=[Environment]::GetFolderPath('ProgramFiles');$machine['ProgramFiles(x86)']=[Environment]::GetFolderPath('ProgramFilesX86');$machine['ProgramData']=[Environment]::GetFolderPath('CommonApplicationData'); @{humanSid=$human.User.Value;agentSid=$user.SID.Value;profile=[Environment]::ExpandEnvironmentVariables($profile);machine=$machine}|ConvertTo-Json -Depth 4 -Compress`);
      this.identity = identitySchema.parse(JSON.parse(output));
      try {
        const journal = journalSchema.parse(JSON.parse(await readFile(this.journalPath, "utf8")));
        if (journal.sid !== this.identity.agentSid) throw new Error("sandbox state の SID が不一致");
        this.leases = journal.leases;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      return true;
    } catch { return false; }
  }

  private save(): void {
    writeFileAtomic(this.journalPath, `${JSON.stringify({ sid: this.identity!.agentSid, leases: this.leases }, null, 2)}\n`);
  }

  private async runtime(): Promise<string> {
    const identity = this.identity!;
    const root = join(process.env.ProgramData ?? "C:\\ProgramData", `Clodex-Sandbox-${identity.humanSid}`);
    // 同一 SID の Agent が runtime を差し替えられないよう、親ごと継承を遮断する。
    await runHost(`$path=${psQuote(root)}; $human=[Security.Principal.SecurityIdentifier]::new(${psQuote(identity.humanSid)}); if(Test-Path -LiteralPath $path){$old=Get-Acl -LiteralPath $path; if($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $human.Value){throw 'runtime の所有者が不一致'}; if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'runtime は reparse point'}}else{[void][IO.Directory]::CreateDirectory($path)}; $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($human);$acl.SetAccessRuleProtection($true,$false);foreach($sid in @($human.Value,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new(${psQuote(identity.agentSid)}),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'));[IO.Directory]::SetAccessControl($path,$acl)`);
    await noReparse(root);
    const runtime = join(root, randomUUID());
    await mkdir(runtime);
    await writeFile(join(runtime, "token-helper.cs"), nativeSource, { flag: "wx" });
    await writeFile(join(runtime, "broker.cjs"), brokerSource, { flag: "wx" });
    await copyFile(process.execPath, join(runtime, "node.exe"));
    const environment = buildAgentEnvironment(identity.profile, identity.machine, { USERNAME: ACCOUNT, USERDOMAIN: process.env.COMPUTERNAME, COMPUTERNAME: process.env.COMPUTERNAME });
    await writeFile(join(runtime, "environment.json"), JSON.stringify(environment), { flag: "wx" });
    const environmentScript = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'; $settings=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'environment.json') -Raw|ConvertFrom-Json; foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)){[Environment]::SetEnvironmentVariable($name,$null,'Process')}; foreach($entry in $settings.PSObject.Properties){[Environment]::SetEnvironmentVariable($entry.Name,[string]$entry.Value,'Process')}; [Environment]::SetEnvironmentVariable('HOME',$null,'Process'); foreach($name in @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','NODE_OPTIONS','NODE_PATH')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}; [void][IO.Directory]::CreateDirectory($env:TEMP);`;
    await writeFile(join(runtime, "environment.ps1"), `\uFEFF${environmentScript}`, { flag: "wx" });
    const bootstrap = `param([int]$Port,[string]$Token)\n. (Join-Path $PSScriptRoot 'environment.ps1'); & (Join-Path $PSScriptRoot 'node.exe') (Join-Path $PSScriptRoot 'broker.cjs') $Port $Token ${psQuote(identity.agentSid)}; exit $LASTEXITCODE`;
    await writeFile(join(runtime, "bootstrap.ps1"), `\uFEFF${bootstrap}`, { flag: "wx" });
    await writeFile(join(runtime, "login.ps1"), `\uFEFF. (Join-Path $PSScriptRoot 'environment.ps1'); Set-Location -LiteralPath $env:USERPROFILE; Write-Host 'claude と codex login にログイン後、exit で終了'`, { flag: "wx" });
    const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    await runHost(`& ${psQuote(compiler)} /nologo /target:exe /platform:x64 ${psQuote(`/out:${join(runtime, "token-helper.exe")}`)} ${psQuote(join(runtime, "token-helper.cs"))}; if($LASTEXITCODE -ne 0){throw 'native helper のコンパイル失敗'}`);
    this.runtimeDir = runtime;
    return runtime;
  }

  async connect(checkCli = true): Promise<void> {
    if (this.broker) return;
    if (!this.identity) throw new Error("セットアップ未完了");
    const runtime = await this.runtime();
    this.broker = await connectBroker({ launch: async (port, token) => {
      const tokenPath = join(this.home, ".clodex", `sandbox-token-${randomUUID()}`);
      const argumentsText = `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${join(runtime, "bootstrap.ps1")}" -Port ${port} -Token ${token}`;
      if (POWERSHELL.length + argumentsText.length + 3 > MAX_LOGON_COMMAND) throw new Error("broker の起動引数が長すぎる");
      try {
        await runHost(`$path=${psQuote(tokenPath)};[IO.File]::WriteAllText($path,'');$acl=[Security.AccessControl.FileSecurity]::new();$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));[IO.File]::SetAccessControl($path,$acl);[IO.File]::WriteAllText($path,[Console]::ReadLine());$secret=Get-Content -LiteralPath ${psQuote(this.credentialPath)} -Raw|ConvertTo-SecureString;$credential=[Management.Automation.PSCredential]::new("$env:COMPUTERNAME\\${ACCOUNT}",$secret);try{$token=Get-Content -LiteralPath $path -Raw; $p=Start-Process -FilePath ${psQuote(POWERSHELL)} -ArgumentList (${psQuote(argumentsText.replace(token, ""))}+$token) -Credential $credential -LoadUserProfile -WorkingDirectory ${psQuote(runtime)} -WindowStyle Hidden -RedirectStandardOutput ${psQuote(`${tokenPath}.stdout`)} -RedirectStandardError ${psQuote(`${tokenPath}.stderr`)} -PassThru; if($p.WaitForExit(1500) -and $p.ExitCode -ne 0){throw ('broker bootstrap: '+(Get-Content -LiteralPath ${psQuote(`${tokenPath}.stderr`)} -Raw))}}finally{$secret.Dispose()}`, `${token}\n`);
      } catch (error) { await unlink(tokenPath).catch(() => {}); throw error; }
      return async () => { for (const path of [tokenPath, `${tokenPath}.stdout`, `${tokenPath}.stderr`]) await removeTemporary(path); };
    } });
    if (!checkCli) return;
    try {
      await this.broker.run("claude", ["--version"], runtime);
      await this.broker.run("codex", ["--version"], runtime);
    } catch {
      await this.close();
      throw new Error("セットアップ未完了");
    }
  }

  async setupStatus(): Promise<SetupStatus> {
    const base: SetupStatus = { managed: false, user: false, credential: false, claude: false, codex: false, pnpm: false, authenticated: false };
    if (process.platform !== "win32") return base;
    const state = z.object({ user: z.boolean(), credential: z.boolean() }).parse(JSON.parse(await runHost(`@{user=[bool](Get-LocalUser -Name '${ACCOUNT}' -ErrorAction SilentlyContinue);credential=[bool](Test-Path -LiteralPath ${psQuote(this.credentialPath)})}|ConvertTo-Json -Compress`)));
    Object.assign(base, state);
    if (!await this.inspect()) return base;
    base.user = true;
    base.credential = true;
    try {
      const account = z.object({ configured: z.boolean(), humanSid: z.string(), agentSid: z.string() }).parse(JSON.parse(await readFile(join(this.home, ".clodex", "sandbox-account.json"), "utf8")));
      base.managed = account.configured && account.humanSid === this.identity!.humanSid && account.agentSid === this.identity!.agentSid;
    } catch { /* spike からの移行も管理者処理で検査する。 */ }
    try {
      await this.connect(false);
      const output = await this.broker!.run("node", ["-e", "const f=require('node:fs'),p=require('node:path');console.log(JSON.stringify({claude:f.existsSync(p.join(process.env.USERPROFILE,'.local','bin','claude.exe')),codex:f.existsSync(p.join(process.env.APPDATA,'npm','node_modules','@openai','codex','bin','codex.js')),pnpm:f.existsSync(p.join(process.env.APPDATA,'npm','node_modules','pnpm','bin','pnpm.cjs'))}))"], this.identity!.profile);
      const cli = z.object({ claude: z.boolean(), codex: z.boolean(), pnpm: z.boolean() }).parse(JSON.parse(output));
      for (const command of ["claude", "codex", "pnpm"] as const) {
        if (cli[command]) try { await this.broker!.run(command, ["--version"], this.identity!.profile); } catch { cli[command] = false; }
      }
      let authenticated = false;
      try {
        const complete = z.object({ authenticated: z.boolean(), agentSid: z.string() }).parse(JSON.parse(await readFile(join(this.home, ".clodex", "sandbox-setup.json"), "utf8")));
        authenticated = complete.authenticated && complete.agentSid === this.identity!.agentSid;
      } catch { /* 初回は startup probe で検査する。 */ }
      return { ...base, ...cli, authenticated };
    } catch { return base; }
  }

  async saveSetupComplete(authenticated: boolean): Promise<void> {
    writeFileAtomic(join(this.home, ".clodex", "sandbox-setup.json"), `${JSON.stringify({ authenticated, agentSid: this.identity?.agentSid ?? "" })}\n`);
  }

  async ready(): Promise<boolean> { return setupComplete(await this.setupStatus()); }

  async setup(): Promise<void> {
    const key = this.home.toLowerCase();
    const previous = WindowsSandboxPlatform.setups.get(key);
    if (previous) { await previous; return; }
    const pending = this.runSetup();
    WindowsSandboxPlatform.setups.set(key, pending);
    try { await pending; } finally { WindowsSandboxPlatform.setups.delete(key); }
  }

  private async runSetup(): Promise<void> {
    if (process.platform !== "win32") throw new Error("Windows 専用");
    const account = new WindowsAccountSetup(this.home);
    await ensureSandboxSetup({
      cleanup: () => account.cleanupPassword(),
      status: () => this.setupStatus(),
      createUser: () => account.create(),
      connect: async () => {
        if (!await this.inspect()) { await account.initializeProfile(); if (!await this.inspect()) throw new Error(t("sandbox.incomplete")); }
        await this.connect(false);
      },
      install: (status) => this.installCli(status), login: () => this.login(), authenticate: () => this.authenticate(),
      saveComplete: (complete) => this.saveSetupComplete(complete), close: () => this.close(),
    }, this.notice);
  }

  async uninstall(): Promise<void> {
    this.notice(t("sandbox.uninstall"));
    const account = new WindowsAccountSetup(this.home);
    const directory = join(this.home, ".clodex");
    const journals = (await readdir(directory)).filter((name) => /^sandbox-project-[a-f0-9]{16}\.json$/.test(name));
    if (await this.inspect()) await this.connect(false);
    try {
      for (const name of journals) {
        const path = join(directory, name);
        await noReparse(path);
        const journal = journalSchema.parse(JSON.parse(await readFile(path, "utf8")));
        if (!journal.leases.length) continue;
        if (!this.identity || journal.sid !== this.identity.agentSid) throw new Error("ACL 解除に必要な専用ユーザーの資格情報なし");
        const previous = this.leases;
        const previousPath = this.journalPath;
        this.journalPath = path;
        this.leases = journal.leases;
        try { await this.release(); }
        finally {
          writeFileAtomic(path, `${JSON.stringify({ sid: journal.sid, leases: this.leases }, null, 2)}\n`);
          this.leases = previous;
          this.journalPath = previousPath;
        }
      }
    } finally { await this.close(); }
    await account.uninstall();
    this.identity = undefined;
    this.leases = [];
  }

  async installCli(status: SetupStatus): Promise<void> {
    if (!this.broker || !this.identity) throw new Error("broker 未接続");
    const script = [
      ...(!status.claude ? ["& ([scriptblock]::Create((Invoke-RestMethod 'https://claude.ai/install.ps1')))"] : []),
      ...(!status.codex || !status.pnpm ? ["$env:NPM_CONFIG_PREFIX=Join-Path $env:APPDATA 'npm'; & npm.cmd install --global @openai/codex pnpm; if($LASTEXITCODE -ne 0){throw 'CLI のインストール失敗'}"] : []),
    ].join("; ");
    const INSTALL_TIMEOUT = 10 * 60_000;
    if (script) await this.broker.run(POWERSHELL, psArgs(script), this.identity.profile, INSTALL_TIMEOUT);
    for (const command of ["claude", "codex", "pnpm"]) await this.broker.run(command, ["--version"], this.identity.profile);
  }

  async authenticate(): Promise<boolean> {
    if (!this.broker || !this.identity) return false;
    const probe = await fetchStartupProbe(this.identity.profile, this.spawn);
    return probe.models.claude.length > 0 && probe.models.codex.length > 0 && Boolean(probe.usage.claude && probe.usage.codex);
  }

  async login(): Promise<void> {
    if (!this.runtimeDir || !this.identity) throw new Error("broker 未接続");
    const command = `-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "${join(this.runtimeDir, "login.ps1")}"`;
    if (POWERSHELL.length + command.length + 3 > MAX_LOGON_COMMAND) throw new Error("ログインの起動引数が長すぎる");
    await runHost(`$secret=Get-Content -LiteralPath ${psQuote(this.credentialPath)} -Raw|ConvertTo-SecureString;$credential=[Management.Automation.PSCredential]::new("$env:COMPUTERNAME\\${ACCOUNT}",$secret);try{Start-Process -FilePath ${psQuote(POWERSHELL)} -ArgumentList ${psQuote(command)} -Credential $credential -LoadUserProfile -WorkingDirectory ${psQuote(this.identity.profile)} -WindowStyle Normal -Wait}finally{$secret.Dispose()}`);
  }

  private async snapshot(path: string, add = false): Promise<Acl> {
    return aclSchema.parse(JSON.parse(await runHost(`${aclPrelude(path, this.identity!.agentSid)} ${add ? "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow'));" : ""} Snapshot $acl | ConvertTo-Json -Depth 5 -Compress`)));
  }

  private async applyAcl(path: string, expected: Acl, next: Acl): Promise<void> {
    await noReparse(path);
    const current = await this.snapshot(path);
    if (ruleSignature(current) !== ruleSignature(expected)) throw new Error(`ACL の同時変更: ${path}`);
    const rules = next.rules.map((rule) => `$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]${rule.rights},[Security.AccessControl.InheritanceFlags]${rule.inheritance},[Security.AccessControl.PropagationFlags]${rule.propagation},[Security.AccessControl.AccessControlType]${rule.type}));`).join("\n");
    await runHost(`${aclPrelude(path, this.identity!.agentSid)} foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){if($rule.IdentityReference.Value -eq $sid.Value){[void]$acl.RemoveAccessRuleSpecific($rule)}};${rules} [IO.Directory]::SetAccessControl($path,$acl)`);
  }

  private async git(agent: boolean, args: string[]): Promise<string> {
    const allowed = args.includes("--get-all") ? [0, 1] : args.includes("--unset-all") ? [0, 5] : [0];
    if (agent) {
      if (!this.broker) throw new Error("broker 未接続");
      try { return await this.broker.run("git", args, this.identity!.profile); }
      catch (error) { if (error instanceof BrokerExitError && error.code !== null && allowed.includes(error.code)) return ""; throw error; }
    }
    return runHost(`& git ${args.map(psQuote).join(" ")};if(@(${allowed.join(",")}) -notcontains $LASTEXITCODE){throw 'safe.directory の更新失敗'}`);
  }

  async grant(path: string, git: boolean): Promise<void> {
    validateSandboxPath(path, this.home);
    await noReparse(path);
    let lease = this.leases.find((entry) => entry.path.toLowerCase() === path.toLowerCase());
    if (!lease) {
      lease = { path, before: await this.snapshot(path), after: await this.snapshot(path, true), gitHuman: false, gitAgent: false };
      this.leases.push(lease);
      this.save();
    }
    const current = await this.snapshot(path);
    if (ruleSignature(current) === ruleSignature(lease.before)) await this.applyAcl(path, lease.before, lease.after);
    else if (ruleSignature(current) !== ruleSignature(lease.after)) throw new Error(`ACL の同時変更: ${path}`);
    if (!git) return;
    for (const agent of [false, true]) {
      const key = agent ? "gitAgent" : "gitHuman";
      const directories = (await this.git(agent, ["config", "--global", "--get-all", "safe.directory"])).split(/\r?\n/);
      const directory = path.replaceAll("\\", "/");
      if (directories.includes(directory)) continue;
      lease[key] = true;
      this.save();
      await this.git(agent, ["config", "--global", "--add", "safe.directory", directory]);
    }
  }

  async release(): Promise<void> {
    for (const lease of [...this.leases].reverse()) {
      for (const agent of [true, false]) {
        const key = agent ? "gitAgent" : "gitHuman";
        if (!lease[key]) continue;
        await this.git(agent, ["config", "--global", "--fixed-value", "--unset-all", "safe.directory", lease.path.replaceAll("\\", "/")]);
        lease[key] = false; this.save();
      }
      const current = await this.snapshot(lease.path);
      if (ruleSignature(current) !== ruleSignature(lease.before)) await this.applyAcl(lease.path, lease.after, lease.before);
      const after = await this.snapshot(lease.path);
      if (after.sddl !== lease.before.sddl) this.notice(`ACL 差分: ${lease.path}`);
      this.leases = this.leases.filter((entry) => entry !== lease); this.save();
    }
  }

  async close(): Promise<void> {
    const broker = this.broker;
    this.broker = undefined;
    await broker?.close();
    const runtime = this.runtimeDir;
    if (runtime) {
      await noReparse(runtime);
      for (const name of ["token-helper.cs", "token-helper.exe", "broker.cjs", "node.exe", "environment.json", "environment.ps1", "bootstrap.ps1", "login.ps1"]) await removeTemporary(join(runtime, name));
      await rmdir(runtime);
      this.runtimeDir = undefined;
    }
  }
}
