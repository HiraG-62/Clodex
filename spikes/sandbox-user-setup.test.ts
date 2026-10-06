import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { psQuote } from "./sandbox-user.js";

const setupPath = fileURLToPath(new URL("./sandbox-user-setup.ps1", import.meta.url));
const run = (script: string) => spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
const loadFunctions = `$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${psQuote(setupPath)},[ref]$tokens,[ref]$errors); foreach($fn in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) { . ([ScriptBlock]::Create($fn.Extent.Text)) };`;

describe.skipIf(process.platform !== "win32")("setup の副作用なし検証", () => {
  it("Deny 対象はシステムドライブを除く固定ドライブだけ", () => {
    const result = run(`${loadFunctions}
$volumes=@(@{DriveType='Fixed';DriveLetter='C'},@{DriveType='Fixed';DriveLetter='E'},@{DriveType='Fixed';DriveLetter='e'},@{DriveType='Removable';DriveLetter='F'},@{DriveType='Fixed';DriveLetter=$null},@{DriveType='Network';DriveLetter='G'});
@(Get-DenyDriveRoots $volumes 'c:') | ConvertTo-Json -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("E:\\");
  });

  it("Deny は書き込み・削除のみで、読み取り・実行・同期を妨げない", () => {
    const result = run(`${loadFunctions}
$rule=New-DriveDenyRule ([Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1001'));
@{rights=[int]$rule.FileSystemRights;inheritance=[string]$rule.InheritanceFlags;propagation=[string]$rule.PropagationFlags;type=[string]$rule.AccessControlType} | ConvertTo-Json -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rights: 65878, inheritance: "ContainerInherit, ObjectInherit", propagation: "None", type: "Deny" });
  });

  it("Deny は変更前に記録し、再実行で重複せず、解除時に別の ACE を残す", () => {
    const result = run(`${loadFunctions}
$sid='S-1-5-21-1-2-3-1001'; $root='E:\\'; $StatePath='unused';
$state=[pscustomobject]@{agentSid=$sid;complete=$true};
$acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'ReadAndExecute','Allow'));
$script:writes=0; $script:saved=$null;
function Write-Host { param($Object) }; function Assert-NoReparsePoint { param($Path) }; function Test-Path { param($LiteralPath) return $true };
function Get-Acl { param($LiteralPath) return $acl };
function Set-PrivateFile { param($Path,$Content) $script:saved=$Content | ConvertFrom-Json };
function Set-Acl { param($LiteralPath,$AclObject) if($script:saved.deniedDrives -notcontains $LiteralPath) { throw 'not-recorded' }; $script:writes++ };
Update-DriveDeny $state @($root); Update-DriveDeny $state @($root);
$afterInstall=$script:writes; Remove-DriveDenyRules $state;
$rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]));
@{installWrites=$afterInstall;totalWrites=$script:writes;remaining=@($rules | ForEach-Object {[string]$_.AccessControlType});drives=$state.deniedDrives;complete=$state.complete} | ConvertTo-Json -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ installWrites: 1, totalWrites: 2, remaining: ["Allow"], drives: ["E:\\"], complete: true });
  });

  it("Deny 反映に失敗しても対象ドライブの記録を残す", () => {
    const result = run(`${loadFunctions}
$state=[pscustomobject]@{agentSid='S-1-5-21-1-2-3-1001';complete=$true}; $StatePath='unused'; $script:saved=$null;
function Write-Host { param($Object) }; function Assert-NoReparsePoint { param($Path) }; function Test-Path { param($LiteralPath) return $true };
function Get-Acl { param($LiteralPath) return [Security.AccessControl.DirectorySecurity]::new() };
function Set-PrivateFile { param($Path,$Content) $script:saved=$Content | ConvertFrom-Json };
function Set-Acl { param($LiteralPath,$AclObject) throw 'simulated-denial' };
try { Update-DriveDeny $state @('E:\\') } catch { if($_.Exception.Message -ne 'simulated-denial') { throw } };
@{complete=$script:saved.complete;drives=$script:saved.deniedDrives} | ConvertTo-Json -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ complete: false, drives: ["E:\\"] });
  });
  it("UTF-8 BOM 付きで PowerShell 5.1 の構文解析が通る", () => {
    expect([...readFileSync(setupPath).subarray(0, 3)]).toEqual([239, 187, 191]);
    const result = run(`$tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile(${psQuote(setupPath)},[ref]$tokens,[ref]$errors); if($errors.Count) { throw ($errors | Out-String) }`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("Status は管理者判定や変更処理へ進まず、有無を JSON で返す", () => {
    const result = run(`function Get-LocalUser { param($Name,$ErrorAction) return $null }; function Test-Path { param($LiteralPath) return $false }; & ${psQuote(setupPath)} -Status`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ userExists: false, credentialExists: false, stateExists: false, configured: false });
  });

  it.each([true, false])("Status は完了記録 %s に従って configured を返す", complete => {
    const result = run(`function Get-LocalUser { param($Name,$ErrorAction) return @{SID=@{Value='test-agent'};Enabled=$true} }; function Test-Path { param($LiteralPath) return $true }; function Get-Content { param($LiteralPath,[switch]$Raw) @{humanSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;agentSid='test-agent';complete=$${complete}} | ConvertTo-Json }; & ${psQuote(setupPath)} -Status`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ userExists: true, credentialExists: true, stateExists: true, configured: complete });
  });

  it("セットアップ済みの再実行は再作成せず、別 SID や未完了状態は拒否する", () => {
    const result = run(`
$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${psQuote(setupPath)},[ref]$tokens,[ref]$errors);
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-SetupAction'},$true);
if(-not $fn) { throw 'Get-SetupAction missing' }; . ([ScriptBlock]::Create($fn.Extent.Text));
$results=@(); $results+=Get-SetupAction $null $null $false 'human' 'E:\\test' 'C:\\artifacts';
$state=@{humanSid='human';agentSid='agent';project='E:\\test';artifacts='C:\\artifacts';complete=$true};
$agent=@{SID=@{Value='agent'};Enabled=$true};
$results+=Get-SetupAction $state $agent $true 'human' 'E:\\test' 'C:\\artifacts';
$results+=Get-SetupAction $state $agent $true 'human' 'E:\\test' 'C:\\artifacts';
$agent.SID.Value='other'; try { Get-SetupAction $state $agent $true 'human' 'E:\\test' 'C:\\artifacts'; throw 'unexpected-success' } catch { if($_.Exception.Message -eq 'unexpected-success') { throw }; $results+='rejected-sid' };
$agent.SID.Value='agent'; $state.complete=$false; try { Get-SetupAction $state $agent $true 'human' 'E:\\test' 'C:\\artifacts'; throw 'unexpected-success' } catch { if($_.Exception.Message -eq 'unexpected-success') { throw }; $results+='rejected-incomplete' };
$results | ConvertTo-Json -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["create", "reuse", "reuse", "rejected-sid", "rejected-incomplete"]);
  });
});
