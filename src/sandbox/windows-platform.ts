import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { SpawnAgentProcess } from "../agents/agent-process.js";
import { t } from "../i18n/i18n.js";
import { writeFileAtomic } from "../project/atomic-write.js";
import { WindowsAccountSetup } from "./account-setup.js";
import { inspectSandboxAuthentication } from "./authentication.js";
import { type BrokerConnection, BrokerExitError, connectBroker } from "./broker.js";
import { brokerSource } from "./broker-source.js";
import type { SandboxPlatform } from "./controller.js";
import { buildAgentEnvironment } from "./environment.js";
import { type GrantKind, gitProtectionPaths, isMissing } from "./git-protection.js";
import { nativeSource } from "./native-source.js";
import { CMD, POWERSHELL, psArgs, psQuote, runHost } from "./powershell.js";
import { prepareRuntimeDirectory, removeRuntimeDirectory } from "./runtime-directory.js";
import { ensureSandboxSetup, type SetupStatus, setupComplete } from "./setup.js";

const ACCOUNT = "clodex-agent";
const MAX_LOGON_COMMAND = 1024;
const JOURNAL_HASH_LENGTH = 16;
const RUNTIME_HASH_LENGTH = 24;
const LAUNCH_CHECK_MS = 1500;
const CLEANUP_ATTEMPTS = 30;
const CLEANUP_INTERVAL = 100;
async function removeTemporary(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      if (error.code === "ENOENT") return;
      if ((error.code !== "EBUSY" && error.code !== "EPERM") || attempt >= CLEANUP_ATTEMPTS) throw error;
      await delay(CLEANUP_INTERVAL);
    }
  }
}
const ruleSchema = z.object({
  rights: z.number(),
  inheritance: z.number(),
  propagation: z.number(),
  type: z.number(),
  owner: z.literal(true).optional(),
  human: z.literal(true).optional(),
});
const aclSchema = z.object({ sddl: z.string(), rules: z.array(ruleSchema) });
const leaseSchema = z.object({ path: z.string(), before: aclSchema, after: aclSchema, gitHuman: z.boolean(), gitAgent: z.boolean() });
const journalSchema = z.object({ sid: z.string(), leases: z.array(leaseSchema) });
type Lease = z.infer<typeof leaseSchema>;
type Acl = z.infer<typeof aclSchema>;
const identitySchema = z.object({ humanSid: z.string(), agentSid: z.string(), profile: z.string(), machine: z.record(z.string(), z.string()) });
type Identity = z.infer<typeof identitySchema>;

export function normalizeSandboxPath(path: string): string {
  return win32.resolve(path).replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
}
export function validateSandboxPath(path: string, home: string, artifacts = false): void {
  const normalized = win32.resolve(path);
  const relative = win32.relative(normalized, win32.resolve(home));
  if (
    !/^[A-Za-z]:\\/.test(path) ||
    normalized === win32.parse(normalized).root ||
    relative === "" ||
    (!relative.startsWith("..") && !win32.isAbsolute(relative))
  )
    throw new Error(t("sandbox.pathDenied", { path: path }));
  const candidate = normalizeSandboxPath(path);
  const blocked = [win32.join(home, ".clodex"), win32.join(home, "AppData")].some(
    root => candidate === normalizeSandboxPath(root) || candidate.startsWith(`${normalizeSandboxPath(root)}/`),
  );
  const artifactChild = candidate.startsWith(`${normalizeSandboxPath(win32.join(home, ".clodex", "artifacts"))}/`);
  if (blocked && !(artifacts && artifactChild)) throw new Error(t("sandbox.pathDenied", { path: path }));
}

async function noReparse(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error(t("sandbox.reparse", { path: current }));
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

const aclPrelude = (path: string, sid: string, human: string) =>
  `$path=${psQuote(path)}; $sid=[Security.Principal.SecurityIdentifier]::new(${psQuote(sid)});$ownerRights=[Security.Principal.SecurityIdentifier]::new('S-1-3-4');$human=[Security.Principal.SecurityIdentifier]::new(${psQuote(human)}); $directory=[IO.Directory]::Exists($path); $acl=if($directory){[IO.Directory]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Access)}else{[IO.File]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Access)}; function Snapshot($value) { @{sddl=$value.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);rules=@($value.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -in @($sid.Value,$ownerRights.Value,$human.Value)} | ForEach-Object {$r=@{rights=[int]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;type=[int]$_.AccessControlType};if($_.IdentityReference.Value -eq $ownerRights.Value){$r.owner=$true};if($_.IdentityReference.Value -eq $human.Value){$r.human=$true};$r})} };`;
const ruleSignature = (acl: Acl) => JSON.stringify(acl.rules.map(rule => JSON.stringify(rule)).sort());

export class WindowsSandboxPlatform implements SandboxPlatform {
  private static readonly setups = new Map<string, Promise<void>>();
  private static readonly recoveries = new Map<string, Promise<void>>();
  private identity: Identity | undefined;
  private broker: BrokerConnection | undefined;
  private runtimeDir: string | undefined;
  private leases: Lease[] = [];
  private journalPath: string;
  private readonly credentialPath: string;
  constructor(
    private readonly home: string,
    project: string,
    private readonly notice: (text: string) => void = () => {},
  ) {
    const hash = createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0, JOURNAL_HASH_LENGTH);
    this.journalPath = join(home, ".clodex", `sandbox-project-${hash}.json`);
    this.credentialPath = join(home, ".clodex", "agent-credential");
  }
  readonly spawn: SpawnAgentProcess = (command, args, options) => {
    if (!this.broker) throw new Error(t("sandbox.disconnected"));
    return this.broker.spawn(command, args, options);
  };

  async inspect(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      await noReparse(this.credentialPath);
      const output = await runHost(
        `$human=[Security.Principal.WindowsIdentity]::GetCurrent(); if(([Security.Principal.WindowsPrincipal]::new($human)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw ${psQuote(t("sandbox.adminDenied"))}}; $user=Get-LocalUser -Name '${ACCOUNT}'; if(-not $user.Enabled){throw ${psQuote(t("sandbox.userDisabled"))}}; $profile=(Get-ItemProperty -LiteralPath ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$user.SID.Value)).ProfileImagePath; $machine=[Environment]::GetEnvironmentVariables('Machine');$machine['SystemRoot']=[Environment]::GetFolderPath('Windows');$machine['ProgramFiles']=[Environment]::GetFolderPath('ProgramFiles');$machine['ProgramFiles(x86)']=[Environment]::GetFolderPath('ProgramFilesX86');$machine['ProgramData']=[Environment]::GetFolderPath('CommonApplicationData'); @{humanSid=$human.User.Value;agentSid=$user.SID.Value;profile=[Environment]::ExpandEnvironmentVariables($profile);machine=$machine}|ConvertTo-Json -Depth 4 -Compress`,
      );
      this.identity = identitySchema.parse(JSON.parse(output));
      const key = this.home.toLowerCase();
      let recovery = WindowsSandboxPlatform.recoveries.get(key);
      if (!recovery) {
        recovery = this.recoverStaleJournals();
        WindowsSandboxPlatform.recoveries.set(key, recovery);
      }
      try {
        await recovery;
      } finally {
        if (WindowsSandboxPlatform.recoveries.get(key) === recovery) WindowsSandboxPlatform.recoveries.delete(key);
      }
      try {
        const journal = journalSchema.parse(JSON.parse(await readFile(this.journalPath, "utf8")));
        if (journal.sid !== this.identity.agentSid) throw new Error(t("sandbox.sidMismatch"));
        this.leases = journal.leases;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      return true;
    } catch {
      return false;
    }
  }

  private save(): void {
    writeFileAtomic(this.journalPath, `${JSON.stringify({ sid: this.identity!.agentSid, leases: this.leases }, null, 2)}\n`);
  }

  private async recoverStaleJournals(): Promise<void> {
    const directory = join(this.home, ".clodex");
    for (const name of await this.journalNames()) {
      const path = join(directory, name);
      await noReparse(path);
      const journal = journalSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (journal.sid === this.identity!.agentSid) continue;
      for (const lease of [...journal.leases].reverse()) {
        validateSandboxPath(lease.path, this.home, true);
        if (lease.gitHuman) await this.removeSafeDirectory(false, lease.path);
        try {
          await noReparse(lease.path);
          await runHost(
            `$a=Get-Acl -LiteralPath ${psQuote(lease.path)};if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne ${psQuote(this.identity!.humanSid)}){throw ${psQuote(t("sandbox.credentialMissing"))}}`,
          );
          const current = await this.snapshot(lease.path, undefined, journal.sid);
          const next: Acl = { ...current, rules: current.rules.filter(rule => rule.owner || rule.human) };
          for (const field of ["owner", "human"] as const) {
            const actual = { ...current, rules: current.rules.filter(rule => rule[field]) };
            const expected = { ...lease.after, rules: lease.after.rules.filter(rule => rule[field]) };
            if (ruleSignature(actual) === ruleSignature(expected))
              next.rules = [...next.rules.filter(rule => !rule[field]), ...lease.before.rules.filter(rule => rule[field])];
          }
          await this.applyAcl(lease.path, current, next, journal.sid);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        journal.leases = journal.leases.filter(entry => entry !== lease);
        writeFileAtomic(path, JSON.stringify(journal));
      }
      writeFileAtomic(path, JSON.stringify({ sid: this.identity!.agentSid, leases: [] }));
    }
  }

  private async journalNames(): Promise<string[]> {
    try {
      return (await readdir(join(this.home, ".clodex"))).filter(name => /^sandbox-project-[a-f0-9]{16}\.json$/.test(name));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private runtimeRoot(humanSid: string): string {
    return join(process.env.ProgramData ?? "C:\\ProgramData", `Clodex-Sandbox-${humanSid}`);
  }

  private async runtime(): Promise<string> {
    const identity = this.identity!;
    const root = this.runtimeRoot(identity.humanSid);
    await prepareRuntimeDirectory(root, identity.humanSid, identity.agentSid);
    const environment = buildAgentEnvironment(identity.profile, identity.machine, {
      USERNAME: ACCOUNT,
      USERDOMAIN: process.env.COMPUTERNAME,
      COMPUTERNAME: process.env.COMPUTERNAME,
    });
    const environmentScript = `$env:PSModulePath="$PSHOME\\Modules";$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'; $settings=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'environment.json') -Raw|ConvertFrom-Json; foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)){[Environment]::SetEnvironmentVariable($name,$null,'Process')}; foreach($entry in $settings.PSObject.Properties){[Environment]::SetEnvironmentVariable($entry.Name,[string]$entry.Value,'Process')}; [Environment]::SetEnvironmentVariable('HOME',$null,'Process'); foreach($name in @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','NODE_OPTIONS','NODE_PATH')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}; [void][IO.Directory]::CreateDirectory($env:TEMP);`;
    // npm \u306E .ps1 \u306E shim \u3092\u547C\u3079\u308B\u3088\u3046\u3001\u3053\u306E\u30A6\u30A3\u30F3\u30C9\u30A6\u3067\u3060\u3051\u30B9\u30AF\u30EA\u30D7\u30C8\u306E\u5B9F\u884C\u3092\u8A31\u3059
    const loginScript = `\uFEFF. (Join-Path $PSScriptRoot 'environment.ps1'); Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Set-Location -LiteralPath $env:USERPROFILE; Write-Host ${psQuote(t("sandbox.loginInstructions"))}`;
    const hash = createHash("sha256")
      .update(nativeSource)
      .update(brokerSource)
      .update(environmentScript)
      .update(loginScript)
      .update(JSON.stringify(environment))
      .update(await readFile(process.execPath))
      .digest("hex")
      .slice(0, RUNTIME_HASH_LENGTH);
    const runtime = join(root, hash);
    try {
      await noReparse(join(runtime, "complete"));
      this.runtimeDir = runtime;
      return runtime;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await mkdir(runtime, { recursive: true });
    await noReparse(runtime);
    await writeFile(join(runtime, "token-helper.cs"), nativeSource);
    await writeFile(join(runtime, "broker.cjs"), brokerSource);
    await copyFile(process.execPath, join(runtime, "node.exe"));
    await writeFile(join(runtime, "environment.json"), JSON.stringify(environment));
    await writeFile(join(runtime, "environment.ps1"), `\uFEFF${environmentScript}`);
    await writeFile(join(runtime, "login.ps1"), loginScript);
    const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    await runHost(
      `& ${psQuote(compiler)} /nologo /target:exe /platform:x64 /reference:System.Web.Extensions.dll ${psQuote(`/out:${join(runtime, "token-helper.exe")}`)} ${psQuote(join(runtime, "token-helper.cs"))}; if($LASTEXITCODE -ne 0){throw ${psQuote(t("sandbox.compileFailed"))}}`,
    );
    await writeFile(join(runtime, "complete"), hash);
    this.runtimeDir = runtime;
    return runtime;
  }

  async connect(checkCli = true): Promise<void> {
    if (this.broker) return;
    if (!this.identity) throw new Error(t("sandbox.incomplete"));
    const runtime = await this.runtime();
    this.broker = await connectBroker({
      launch: async (port, token) => {
        const tokenPath = join(this.home, ".clodex", `sandbox-token-${randomUUID()}`);
        const executable = join(runtime, "token-helper.exe");
        const argumentsText = `--broker ${this.identity!.humanSid} "${runtime}" ${port}`;
        if (executable.length + argumentsText.length + 3 > MAX_LOGON_COMMAND) throw new Error(t("sandbox.argumentsLong"));
        try {
          await runHost(
            `$path=${psQuote(tokenPath)};[IO.File]::WriteAllText($path,'');$acl=[Security.AccessControl.FileSecurity]::new();$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));[IO.File]::SetAccessControl($path,$acl);[IO.File]::WriteAllText($path,[Console]::ReadLine()+[Environment]::NewLine);$secret=Get-Content -LiteralPath ${psQuote(this.credentialPath)} -Raw|ConvertTo-SecureString;$credential=[Management.Automation.PSCredential]::new("$env:COMPUTERNAME\\${ACCOUNT}",$secret);try{$p=Start-Process -FilePath ${psQuote(executable)} -ArgumentList ${psQuote(argumentsText)} -RedirectStandardInput ${psQuote(tokenPath)} -Credential $credential -LoadUserProfile -WorkingDirectory ${psQuote(runtime)} -WindowStyle Hidden -RedirectStandardOutput ${psQuote(`${tokenPath}.stdout`)} -RedirectStandardError ${psQuote(`${tokenPath}.stderr`)} -PassThru; if($p.WaitForExit(${LAUNCH_CHECK_MS}) -and $p.ExitCode -ne 0){throw ('broker bootstrap: '+(Get-Content -LiteralPath ${psQuote(`${tokenPath}.stderr`)} -Raw))}}finally{$secret.Dispose()}`,
            `${token}\n`,
          );
        } catch (error) {
          await unlink(tokenPath).catch(() => {});
          throw error;
        }
        return async () => {
          for (const path of [tokenPath, `${tokenPath}.stdout`, `${tokenPath}.stderr`]) await removeTemporary(path);
        };
      },
    });
    if (!checkCli) return;
    try {
      await this.broker.run("claude", ["--version"], runtime);
      await this.broker.run("codex", ["--version"], runtime);
    } catch {
      await this.close();
      throw new Error(t("sandbox.incomplete"));
    }
  }

  async setupStatus(): Promise<SetupStatus> {
    const base: SetupStatus = { managed: false, user: false, credential: false, claude: false, codex: false, pnpm: false, authenticated: false };
    if (process.platform !== "win32") return base;
    const state = z
      .object({ user: z.boolean(), credential: z.boolean() })
      .parse(
        JSON.parse(
          await runHost(
            `@{user=[bool](Get-LocalUser -Name '${ACCOUNT}' -ErrorAction SilentlyContinue);credential=[bool](Test-Path -LiteralPath ${psQuote(this.credentialPath)})}|ConvertTo-Json -Compress`,
          ),
        ),
      );
    Object.assign(base, state);
    if (!(await this.inspect())) return base;
    base.user = true;
    base.credential = true;
    try {
      const account = z
        .object({ configured: z.boolean(), humanSid: z.string(), agentSid: z.string() })
        .parse(JSON.parse(await readFile(join(this.home, ".clodex", "sandbox-account.json"), "utf8")));
      base.managed = account.configured && account.humanSid === this.identity!.humanSid && account.agentSid === this.identity!.agentSid;
    } catch {
      /* spike からの移行も管理者処理で検査する。 */
    }
    try {
      await this.connect(false);
      const output = await this.broker!.run(
        "node",
        [
          "-e",
          "const f=require('node:fs'),p=require('node:path');console.log(JSON.stringify({claude:f.existsSync(p.join(process.env.APPDATA,'npm','node_modules','@anthropic-ai','claude-code','bin','claude.exe')),codex:f.existsSync(p.join(process.env.APPDATA,'npm','node_modules','@openai','codex','bin','codex.js')),pnpm:['pnpm.cjs','pnpm.mjs'].some(name=>f.existsSync(p.join(process.env.APPDATA,'npm','node_modules','pnpm','bin',name)))}))",
        ],
        this.identity!.profile,
      );
      const cli = z.object({ claude: z.boolean(), codex: z.boolean(), pnpm: z.boolean() }).parse(JSON.parse(output));
      for (const command of ["claude", "codex", "pnpm"] as const) {
        if (cli[command])
          try {
            await this.broker!.run(command, ["--version"], this.identity!.profile);
          } catch {
            cli[command] = false;
          }
      }
      const authenticated = cli.claude && cli.codex && (await this.authenticate());
      return { ...base, ...cli, authenticated };
    } catch {
      return base;
    }
  }

  async saveSetupComplete(authenticated: boolean): Promise<void> {
    writeFileAtomic(join(this.home, ".clodex", "sandbox-setup.json"), `${JSON.stringify({ authenticated, agentSid: this.identity?.agentSid ?? "" })}\n`);
  }

  setupRecorded(): boolean {
    try {
      const record = z.object({ authenticated: z.literal(true), agentSid: z.string().min(1) });
      return record.safeParse(JSON.parse(readFileSync(join(this.home, ".clodex", "sandbox-setup.json"), "utf8"))).success;
    } catch {
      return false;
    }
  }

  async ready(): Promise<boolean> {
    return setupComplete(await this.setupStatus());
  }

  async setup(): Promise<void> {
    const key = this.home.toLowerCase();
    const previous = WindowsSandboxPlatform.setups.get(key);
    if (previous) {
      await previous;
      return;
    }
    const pending = this.runSetup();
    WindowsSandboxPlatform.setups.set(key, pending);
    try {
      await pending;
    } finally {
      WindowsSandboxPlatform.setups.delete(key);
    }
  }

  private async runSetup(): Promise<void> {
    if (process.platform !== "win32") throw new Error(t("sandbox.windowsOnly"));
    const account = new WindowsAccountSetup(this.home);
    await ensureSandboxSetup(
      {
        cleanup: () => account.cleanupPassword(),
        status: () => this.setupStatus(),
        createUser: () => account.create(),
        connect: async () => {
          if (!(await this.inspect())) {
            await account.initializeProfile();
            if (!(await this.inspect())) throw new Error(t("sandbox.incomplete"));
          }
          await this.connect(false);
        },
        install: status => this.installCli(status),
        login: () => this.login(),
        authenticate: () => this.authenticate(),
        saveComplete: complete => this.saveSetupComplete(complete),
        close: () => this.close(),
      },
      this.notice,
    );
  }

  async uninstall(): Promise<void> {
    this.notice(t("sandbox.uninstall"));
    const account = new WindowsAccountSetup(this.home);
    const directory = join(this.home, ".clodex");
    const journals = await this.journalNames();
    if (await this.inspect()) await this.connect(false);
    try {
      for (const name of journals) {
        const path = join(directory, name);
        await noReparse(path);
        const journal = journalSchema.parse(JSON.parse(await readFile(path, "utf8")));
        if (!journal.leases.length) continue;
        if (!this.identity || journal.sid !== this.identity.agentSid) throw new Error(t("sandbox.credentialMissing"));
        const previous = this.leases;
        const previousPath = this.journalPath;
        this.journalPath = path;
        this.leases = journal.leases;
        try {
          await this.release();
        } finally {
          writeFileAtomic(path, `${JSON.stringify({ sid: journal.sid, leases: this.leases }, null, 2)}\n`);
          this.leases = previous;
          this.journalPath = previousPath;
        }
      }
    } finally {
      await this.close();
    }
    const humanSid = this.identity?.humanSid ?? (await runHost("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value")).trim();
    await removeRuntimeDirectory(this.runtimeRoot(humanSid), humanSid);
    await account.uninstall();
    for (const name of journals) {
      const path = join(directory, name);
      await noReparse(path);
      await unlink(path);
    }
    this.identity = undefined;
    this.leases = [];
  }

  async installCli(status: SetupStatus): Promise<void> {
    if (!this.broker || !this.identity) throw new Error(t("sandbox.disconnected"));
    const script =
      !status.claude || !status.codex || !status.pnpm
        ? "$env:NPM_CONFIG_PREFIX=Join-Path $env:APPDATA 'npm'; & npm.cmd install --global @anthropic-ai/claude-code @openai/codex pnpm; exit $LASTEXITCODE"
        : "";
    const INSTALL_TIMEOUT = 10 * 60_000;
    if (script) await this.broker.run(POWERSHELL, psArgs(script), this.identity.profile, INSTALL_TIMEOUT);
    for (const command of ["claude", "codex", "pnpm"]) await this.broker.run(command, ["--version"], this.identity.profile);
  }

  async authenticate(): Promise<boolean> {
    if (!this.broker || !this.identity) return false;
    const auth = await inspectSandboxAuthentication(this.broker, this.identity.profile);
    return auth.claude && auth.codex;
  }

  async login(): Promise<void> {
    if (!this.runtimeDir || !this.identity) throw new Error(t("sandbox.disconnected"));
    // Start-Process -Credential は新しいコンソールを作らず呼び出し元（GUI の Hub では見えない）に相乗りするため、start で別ウィンドウにする
    const command = `/c start "Clodex sandbox" /wait "${POWERSHELL}" -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "${join(this.runtimeDir, "login.ps1")}"`;
    if (CMD.length + command.length + 3 > MAX_LOGON_COMMAND) throw new Error(t("sandbox.argumentsLong"));
    await runHost(
      `$secret=Get-Content -LiteralPath ${psQuote(this.credentialPath)} -Raw|ConvertTo-SecureString;$credential=[Management.Automation.PSCredential]::new("$env:COMPUTERNAME\\${ACCOUNT}",$secret);try{(Start-Process -FilePath ${psQuote(CMD)} -ArgumentList ${psQuote(command)} -Credential $credential -LoadUserProfile -WorkingDirectory ${psQuote(this.identity.profile)} -WindowStyle Hidden -PassThru).WaitForExit()}finally{$secret.Dispose()}`,
    );
  }

  private async snapshot(path: string, kind?: GrantKind, sid = this.identity!.agentSid): Promise<Acl> {
    const rules: Record<GrantKind, string> = {
      modify: "'Modify','ContainerInherit,ObjectInherit','None','Allow'",
      "git-root": "'Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership','None','None','Deny'",
      "git-file": "'Write,Delete,ChangePermissions,TakeOwnership','None','None','Deny'",
      "git-hooks": "'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership','ContainerInherit,ObjectInherit','None','Deny'",
    };
    const ownerRule =
      kind && kind !== "modify"
        ? `$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($human,'FullControl','${kind === "git-hooks" ? "ContainerInherit,ObjectInherit" : "None"}','None','Allow'));foreach($r in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){if($r.IdentityReference.Value -eq $ownerRights.Value){[void]$acl.RemoveAccessRuleSpecific($r)}};$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($ownerRights,'ReadPermissions','${kind === "git-hooks" ? "ContainerInherit,ObjectInherit" : "None"}','None','Allow'));`
        : "";
    return aclSchema.parse(
      JSON.parse(
        await runHost(
          `${aclPrelude(path, sid, this.identity!.humanSid)} ${kind ? `$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,${rules[kind]}));${ownerRule}` : ""} Snapshot $acl | ConvertTo-Json -Depth 5 -Compress`,
        ),
      ),
    );
  }

  private async applyAcl(path: string, expected: Acl, next: Acl, sid = this.identity!.agentSid): Promise<void> {
    await noReparse(path);
    const current = await this.snapshot(path, undefined, sid);
    if (ruleSignature(current) !== ruleSignature(expected)) throw new Error(t("sandbox.aclConflict", { path: path }));
    const rules = next.rules
      .map(
        rule =>
          `$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(${rule.owner ? "$ownerRights" : rule.human ? "$human" : "$sid"},[Security.AccessControl.FileSystemRights]${rule.rights},[Security.AccessControl.InheritanceFlags]${rule.inheritance},[Security.AccessControl.PropagationFlags]${rule.propagation},[Security.AccessControl.AccessControlType]${rule.type}));`,
      )
      .join("\n");
    await runHost(
      `${aclPrelude(path, sid, this.identity!.humanSid)} foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){if($rule.IdentityReference.Value -in @($sid.Value,$ownerRights.Value,$human.Value)){[void]$acl.RemoveAccessRuleSpecific($rule)}};${rules} if($directory){[IO.Directory]::SetAccessControl($path,$acl)}else{[IO.File]::SetAccessControl($path,$acl)}`,
    );
  }

  private async git(agent: boolean, args: string[]): Promise<string> {
    const allowed = args.includes("--get-all") ? [0, 1] : args.includes("--unset-all") ? [0, 5] : [0];
    if (agent) {
      if (!this.broker) throw new Error(t("sandbox.disconnected"));
      try {
        return await this.broker.run("git", args, this.identity!.profile);
      } catch (error) {
        if (error instanceof BrokerExitError && error.code !== null && allowed.includes(error.code)) return "";
        throw error;
      }
    }
    return runHost(`& git ${args.map(psQuote).join(" ")};if(@(${allowed.join(",")}) -notcontains $LASTEXITCODE){throw ${psQuote(t("sandbox.gitFailed"))}}`);
  }

  private async syncGitIdentity(): Promise<void> {
    for (const key of ["user.name", "user.email"]) {
      const output = await runHost(
        `$value=@(& git config --global --get ${psQuote(key)});if($LASTEXITCODE -eq 1){'null'}elseif($LASTEXITCODE -ne 0){throw ${psQuote(t("sandbox.gitFailed"))}}else{ConvertTo-Json -Compress -InputObject ([string]::Join([char]10,$value))}`,
      );
      const value = z.string().nullable().parse(JSON.parse(output));
      if (value !== null) await this.git(true, ["config", "--global", "--replace-all", key, value]);
    }
  }

  async grant(path: string, git: boolean): Promise<void> {
    validateSandboxPath(path, this.home, !git);
    try {
      await noReparse(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (git) {
      for (const target of await gitProtectionPaths(path)) {
        validateSandboxPath(target.path, this.home);
        await noReparse(target.path);
        if (target.kind === "git-root") {
          for (const name of ["config", "config.worktree"]) {
            const file = join(target.path, name);
            try {
              await writeFile(file, "", { flag: "wx" });
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            }
            await this.grantAcl(file, "git-file");
          }
          const hooks = join(target.path, "hooks");
          await mkdir(hooks, { recursive: true });
          await noReparse(hooks);
          await this.grantAcl(hooks, "git-hooks");
        }
        await this.grantAcl(target.path, target.kind);
      }
    }
    const lease = await this.grantAcl(path, "modify");
    if (!git) return;
    await this.syncGitIdentity();
    if (lease.gitHuman) {
      await this.removeSafeDirectory(false, path);
      lease.gitHuman = false;
      this.save();
    }
    const directories = (await this.git(true, ["config", "--global", "--get-all", "safe.directory"])).split(/\r?\n/);
    if (directories.some(directory => directory && normalizeSandboxPath(directory) === normalizeSandboxPath(path))) return;
    lease.gitAgent = true;
    this.save();
    await this.git(true, ["config", "--global", "--add", "safe.directory", path.replaceAll("\\", "/")]);
  }

  private async grantAcl(path: string, kind: GrantKind): Promise<Lease> {
    await noReparse(path);
    let lease = this.leases.find(entry => normalizeSandboxPath(entry.path) === normalizeSandboxPath(path));
    if (!lease) {
      lease = { path, before: await this.snapshot(path), after: await this.snapshot(path, kind), gitHuman: false, gitAgent: false };
      this.leases.push(lease);
      this.save();
    }
    const current = await this.snapshot(path);
    if (ruleSignature(current) === ruleSignature(lease.before)) await this.applyAcl(path, lease.before, lease.after);
    else if (ruleSignature(current) !== ruleSignature(lease.after)) throw new Error(t("sandbox.aclConflict", { path: path }));
    return lease;
  }

  private async removeSafeDirectory(agent: boolean, path: string): Promise<void> {
    const directories = (await this.git(agent, ["config", "--global", "--get-all", "safe.directory"])).split(/\r?\n/);
    for (const directory of new Set(directories.filter(value => value && normalizeSandboxPath(value) === normalizeSandboxPath(path)))) {
      await this.git(agent, ["config", "--global", "--fixed-value", "--unset-all", "safe.directory", directory]);
    }
  }

  async release(): Promise<void> {
    if (!this.identity) {
      let journal: z.infer<typeof journalSchema>;
      try {
        journal = journalSchema.parse(JSON.parse(await readFile(this.journalPath, "utf8")));
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      if (!journal.leases.length) return;
      if (!(await this.inspect())) throw new Error(t("sandbox.incomplete"));
    }
    if (this.leases.some(lease => lease.gitAgent) && !this.broker) await this.connect(false);
    for (const lease of [...this.leases].reverse()) {
      for (const agent of [true, false]) {
        const key = agent ? "gitAgent" : "gitHuman";
        if (!lease[key]) continue;
        await this.removeSafeDirectory(agent, lease.path);
        lease[key] = false;
        this.save();
      }
      try {
        await noReparse(lease.path);
      } catch (error) {
        if (!isMissing(error)) throw error;
        this.leases = this.leases.filter(entry => entry !== lease);
        this.save();
        continue;
      }
      const current = await this.snapshot(lease.path);
      if (ruleSignature(current) !== ruleSignature(lease.before)) await this.applyAcl(lease.path, lease.after, lease.before);
      const after = await this.snapshot(lease.path);
      if (after.sddl !== lease.before.sddl) this.notice(t("sandbox.aclDifference", { path: lease.path }));
      this.leases = this.leases.filter(entry => entry !== lease);
      this.save();
    }
  }

  async close(): Promise<void> {
    const broker = this.broker;
    this.broker = undefined;
    await broker?.close();
    this.runtimeDir = undefined;
  }
}
