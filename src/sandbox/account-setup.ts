import { join } from "node:path";
import { z } from "zod";
import { withAdminErrorReport } from "./admin-error.js";
import { accountSetupSource, accountUninstallSource } from "./admin-scripts.js";
import { POWERSHELL, psQuote, runHost } from "./powershell.js";

export type HostRunner = (script: string, input?: string) => Promise<string>;
const accountSchema = z.object({ humanSid: z.string().regex(/^S-1-/), agentSid: z.string().nullable() });
export const privateFileFunction = String.raw`
function Write-PrivateFile([string]$Path,[string]$Content,[bool]$Administrators=$false){
  if((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'reparse point は対象外'}
  if(-not (Test-Path -LiteralPath $Path)){[IO.File]::WriteAllText($Path,'')}
  $Acl=[Security.AccessControl.FileSecurity]::new()
  $Acl.SetAccessRuleProtection($true,$false)
  $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($Human,'FullControl','Allow'))
  if($Administrators){$Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),'FullControl','Allow'))}
  [IO.File]::SetAccessControl($Path,$Acl)
  [IO.File]::WriteAllText($Path,$Content,[Text.UTF8Encoding]::new($false))
}
`;

export class WindowsAccountSetup {
  constructor(
    private readonly home: string,
    private readonly host: HostRunner = runHost,
  ) {}
  private get adminDir(): string {
    return join(this.home, ".clodex", "sandbox-admin");
  }
  private get passwordPath(): string {
    return join(this.adminDir, "password");
  }

  async cleanupPassword(): Promise<void> {
    await this.host(
      `$path=${psQuote(this.passwordPath)};if(Test-Path -LiteralPath $path){if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse point は対象外'};[IO.File]::Delete($path)}`,
    );
  }

  async prepare(): Promise<{ humanSid: string; agentSid: string | null }> {
    await this.cleanupPassword();
    const directory = join(this.home, ".clodex");
    return accountSchema.parse(
      JSON.parse(
        await this.host(`
$Human=[Security.Principal.WindowsIdentity]::GetCurrent().User
${privateFileFunction}
$Directory=${psQuote(directory)};$AdminDirectory=${psQuote(this.adminDir)}
foreach($Path in @($Directory,$AdminDirectory)){
  $Current=[IO.Path]::GetFullPath($Path)
  while($Current){if((Test-Path -LiteralPath $Current) -and ((Get-Item -LiteralPath $Current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'reparse point は対象外'};$Parent=[IO.Directory]::GetParent($Current);if($null -eq $Parent){break};$Current=$Parent.FullName}
  [void][IO.Directory]::CreateDirectory($Path)
}
$Acl=[Security.AccessControl.DirectorySecurity]::new();$Acl.SetAccessRuleProtection($true,$false)
foreach($Sid in @($Human,[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($Sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
[IO.Directory]::SetAccessControl($AdminDirectory,$Acl)
$AccountPath=Join-Path $Directory 'sandbox-account.json';$LegacyPath=Join-Path $Directory 'sandbox-user-state.json';$CredentialPath=Join-Path $Directory 'agent-credential'
$State=@{humanSid=$Human.Value;agentSid=$null;configured=$false};$Existing=Get-LocalUser -Name 'clodex-agent' -ErrorAction SilentlyContinue
foreach($Path in @($AccountPath,$LegacyPath)){
  if(Test-Path -LiteralPath $Path){$Candidate=Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json;if($Candidate.humanSid -ne $Human.Value){throw '人の SID が不一致'};if($Candidate.agentSid){if($State.agentSid -and $State.agentSid -ne $Candidate.agentSid){throw '記録の SID が不一致'};$State.agentSid=$Candidate.agentSid}}
}
if($Existing -and $State.agentSid -and $State.agentSid -ne $Existing.SID.Value){throw '専用ユーザーの SID が不一致'}
if(-not (Test-Path -LiteralPath $CredentialPath)){
  if($Existing){throw '既存ユーザーの資格情報なし'}
  $Bytes=New-Object byte[] 48;$Random=[Security.Cryptography.RandomNumberGenerator]::Create();try{$Random.GetBytes($Bytes)}finally{$Random.Dispose()}
  $Secret=ConvertTo-SecureString ('Aa9!'+[Convert]::ToBase64String($Bytes)) -AsPlainText -Force
  try{Write-PrivateFile $CredentialPath (ConvertFrom-SecureString $Secret)}finally{$Secret.Dispose();[Array]::Clear($Bytes,0,$Bytes.Length)}
}
Write-PrivateFile $AccountPath ($State|ConvertTo-Json -Compress) $true
$State|ConvertTo-Json -Compress
`),
      ),
    );
  }

  async create(): Promise<void> {
    const state = await this.prepare();
    try {
      await this.host(
        `$Human=[Security.Principal.WindowsIdentity]::GetCurrent().User;${privateFileFunction} $Secret=Get-Content -LiteralPath ${psQuote(join(this.home, ".clodex", "agent-credential"))} -Raw|ConvertTo-SecureString;try{$Credential=[Management.Automation.PSCredential]::new('clodex-agent',$Secret);Write-PrivateFile ${psQuote(this.passwordPath)} $Credential.GetNetworkCredential().Password $true}finally{$Secret.Dispose()}`,
      );
      await this.elevate(accountSetupSource, state.humanSid, true);
    } finally {
      await this.cleanupPassword();
    }
    await this.initializeProfile();
  }

  async initializeProfile(): Promise<void> {
    await this.host(
      `$Secret=Get-Content -LiteralPath ${psQuote(join(this.home, ".clodex", "agent-credential"))} -Raw|ConvertTo-SecureString;$Credential=[Management.Automation.PSCredential]::new("$env:COMPUTERNAME\\clodex-agent",$Secret);try{$Process=Start-Process -FilePath ${psQuote(POWERSHELL)} -ArgumentList '-NoLogo -NoProfile -NonInteractive -Command exit' -WorkingDirectory $env:SystemRoot -Credential $Credential -LoadUserProfile -WindowStyle Hidden -PassThru;$Process.WaitForExit()}finally{$Secret.Dispose()}`,
    );
  }

  async uninstall(): Promise<void> {
    const humanSid = (await this.host("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value")).trim();
    if (!/^S-1-/.test(humanSid)) throw new Error("人の SID を判定不可");
    await this.cleanupPassword();
    await this.elevate(accountUninstallSource, humanSid, false);
    await this.host(
      `foreach($Name in @('agent-credential','sandbox-account.json','sandbox-user-state.json','sandbox-setup.json')){$Path=Join-Path ${psQuote(join(this.home, ".clodex"))} $Name;if(Test-Path -LiteralPath $Path){if((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse point は対象外'};[IO.File]::Delete($Path)}}`,
    );
  }

  private async elevate(source: string, humanSid: string, password: boolean): Promise<void> {
    const path = join(this.adminDir, password ? "setup.ps1" : "uninstall.ps1");
    const errorPath = join(this.adminDir, "error");
    const bytes = Buffer.from(`\uFEFF${withAdminErrorReport(source)}`, "utf8").toString("base64");
    const args = `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path}" -HumanSid "${humanSid}" -HomePath "${this.home}"${password ? ` -SecretFile "${this.passwordPath}"` : ""}`;
    await this.host(
      `$Human=[Security.Principal.WindowsIdentity]::GetCurrent().User;${privateFileFunction} [void][IO.Directory]::CreateDirectory(${psQuote(this.adminDir)});Write-PrivateFile ${psQuote(path)} ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))) $true;Write-PrivateFile ${psQuote(errorPath)} '' $true;try{$Process=Start-Process -FilePath ${psQuote(POWERSHELL)} -ArgumentList ${psQuote(args)} -Verb RunAs -WindowStyle Hidden -PassThru -Wait;if($Process.ExitCode -ne 0){$Detail=[IO.File]::ReadAllText(${psQuote(errorPath)});if($Detail){throw $Detail};throw 'sandbox の管理者処理が未完了'}}finally{[IO.File]::Delete(${psQuote(errorPath)})}`,
      bytes,
    );
  }
}
