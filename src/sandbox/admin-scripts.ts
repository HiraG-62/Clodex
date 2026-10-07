import { profileRemovalSource } from "./profile-removal.js";

export const accountSetupSource = String.raw`
param([Parameter(Mandatory=$true)][string]$HumanSid,[Parameter(Mandatory=$true)][string]$HomePath,[Parameter(Mandatory=$true)][string]$SecretFile)
$ErrorActionPreference='Stop'
$env:PSModulePath="$env:ProgramFiles\WindowsPowerShell\Modules;$PSHOME\Modules"
$Account='clodex-agent'
$StatePath=Join-Path $HomePath '.clodex\sandbox-account.json'
function Assert-LocalPath([string]$Path) {
  $Current=[IO.Path]::GetFullPath($Path)
  while($Current){
    if((Test-Path -LiteralPath $Current) -and ((Get-Item -LiteralPath $Current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'reparse point は対象外'}
    $Parent=[IO.Directory]::GetParent($Current);if($null -eq $Parent){break};$Current=$Parent.FullName
  }
}
Assert-LocalPath $HomePath
Assert-LocalPath $SecretFile
Assert-LocalPath $StatePath
$ExpectedSecret=Join-Path $HomePath '.clodex\sandbox-admin\password'
if([IO.Path]::GetFullPath($SecretFile) -ne [IO.Path]::GetFullPath($ExpectedSecret)){throw 'パスワードの受け渡し先が不一致'}
$Plain=[IO.File]::ReadAllText($SecretFile)
[IO.File]::Delete($SecretFile)
$Secret=ConvertTo-SecureString $Plain -AsPlainText -Force
$Plain=$null
try {
  $State=Get-Content -LiteralPath $StatePath -Raw|ConvertFrom-Json
  if($State.humanSid -ne $HumanSid){throw '人の SID が不一致'}
  $User=Get-LocalUser -Name $Account -ErrorAction SilentlyContinue
  if($User){
    if($State.agentSid -and $State.agentSid -ne $User.SID.Value){throw '専用ユーザーの SID が不一致'}
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class SandboxLogon{[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool LogonUser(string user,string domain,string password,int type,int provider,out IntPtr token);[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr token);}'
    $Handle=[IntPtr]::Zero
    $Credential=[Management.Automation.PSCredential]::new($Account,$Secret)
    if(-not [SandboxLogon]::LogonUser($Account,$env:COMPUTERNAME,$Credential.GetNetworkCredential().Password,3,0,[ref]$Handle)){throw '既存ユーザーの資格情報が不一致'}
    [void][SandboxLogon]::CloseHandle($Handle)
  }else{
    if($State.agentSid){throw '記録した専用ユーザーなし'}
    $User=New-LocalUser -Name $Account -Password $Secret -PasswordNeverExpires -UserMayNotChangePassword
  }
  $State.agentSid=$User.SID.Value
  [IO.File]::WriteAllText($StatePath,($State|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  $Users=Get-LocalGroup -SID 'S-1-5-32-545'
  foreach($Group in Get-LocalGroup){
    $Member=@(Get-LocalGroupMember -Group $Group | Where-Object {$_.SID -eq $User.SID})
    if($Member.Count -and $Group.SID -ne $Users.SID){Remove-LocalGroupMember -Group $Group -Member $User}
  }
  if(-not (Get-LocalGroupMember -Group $Users | Where-Object {$_.SID -eq $User.SID})){Add-LocalGroupMember -Group $Users -Member $User}
  Enable-LocalUser -SID $User.SID
  $Key='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
  [void](New-Item -Path $Key -Force)
  [void](New-ItemProperty -LiteralPath $Key -Name $Account -Value 0 -PropertyType DWord -Force)
  $State.configured=$true
  [IO.File]::WriteAllText($StatePath,($State|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}finally{$Secret.Dispose()}
`;

export const accountUninstallSource = String.raw`
param([Parameter(Mandatory=$true)][string]$HumanSid,[Parameter(Mandatory=$true)][string]$HomePath)
${profileRemovalSource}
$ErrorActionPreference='Stop'
$env:PSModulePath="$env:ProgramFiles\WindowsPowerShell\Modules;$PSHOME\Modules"
function Assert-LocalPath([string]$Path) {
  $Current=[IO.Path]::GetFullPath($Path)
  while($Current){
    if((Test-Path -LiteralPath $Current) -and ((Get-Item -LiteralPath $Current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'reparse point は対象外'}
    $Parent=[IO.Directory]::GetParent($Current);if($null -eq $Parent){break};$Current=$Parent.FullName
  }
}
$Clodex=Join-Path $HomePath '.clodex'
Assert-LocalPath $Clodex
$AccountPath=Join-Path $Clodex 'sandbox-account.json'
$LegacyPath=Join-Path $Clodex 'sandbox-user-state.json'
$State=$null
foreach($Path in @($AccountPath,$LegacyPath)){
  Assert-LocalPath $Path
  if(Test-Path -LiteralPath $Path){
    $Candidate=Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json
    if($Candidate.humanSid -ne $HumanSid){throw '人の SID が不一致'}
    if($State -and $Candidate.agentSid -and $State.agentSid -and $Candidate.agentSid -ne $State.agentSid){throw '記録の SID が不一致'}
    if($Candidate.agentSid){$State=$Candidate}
  }
}
$User=Get-LocalUser -Name 'clodex-agent' -ErrorAction SilentlyContinue
if($User -and (-not $State -or $State.agentSid -ne $User.SID.Value)){throw '削除対象ユーザーの記録なし'}
if(Test-Path -LiteralPath $LegacyPath){
  $Legacy=Get-Content -LiteralPath $LegacyPath -Raw|ConvertFrom-Json
  $Sid=[Security.Principal.SecurityIdentifier]::new($Legacy.agentSid)
  $DriveDenyRights=[int][Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles'
  $DaclSecurityInformation=4
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class SandboxAcl{[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool SetFileSecurity(string path,uint information,byte[] descriptor);}'
  foreach($Root in @($Legacy.deniedDrives)){
    if($Root -notmatch '^[A-Za-z]:\\$' -or $Root.TrimEnd('\') -eq $env:SystemDrive){throw 'Deny 対象外のドライブ'}
    Assert-LocalPath $Root
    # ルートから消えた後に継承 ACE だけ残った場合も、記録したドライブ内で除去する。
    $Pending=[Collections.Generic.Stack[string]]::new();$Pending.Push($Root)
    while($Pending.Count){
      $Path=$Pending.Pop();Assert-LocalPath $Path;$Item=Get-Item -LiteralPath $Path -Force
      if($Item.Attributes -band [IO.FileAttributes]::ReparsePoint){continue}
      $Section=[Security.AccessControl.AccessControlSections]::Access
      $Acl=if($Item.PSIsContainer){[IO.Directory]::GetAccessControl($Item.FullName,$Section)}else{[IO.File]::GetAccessControl($Item.FullName,$Section)}
      $Descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Acl.GetSecurityDescriptorSddlForm($Section))
      $Changed=$false
      for($Index=$Descriptor.DiscretionaryAcl.Count-1;$Index -ge 0;$Index--){
        $Ace=$Descriptor.DiscretionaryAcl[$Index]
        if($Ace -is [Security.AccessControl.CommonAce] -and $Ace.SecurityIdentifier.Value -eq $Sid.Value -and $Ace.AceQualifier -eq 'AccessDenied' -and $Ace.AccessMask -eq $DriveDenyRights){
          $Descriptor.DiscretionaryAcl.RemoveAce($Index);$Changed=$true
        }
      }
      if($Changed){$Bytes=New-Object byte[] $Descriptor.BinaryLength;$Descriptor.GetBinaryForm($Bytes,0);if(-not [SandboxAcl]::SetFileSecurity($Item.FullName,$DaclSecurityInformation,$Bytes)){throw 'Deny の解除失敗'}}
      if($Item.PSIsContainer){foreach($Child in Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop){if(-not ($Child.Attributes -band [IO.FileAttributes]::ReparsePoint)){$Pending.Push($Child.FullName)}}}
    }
  }
  foreach($Path in @($Legacy.paths)){
    Assert-LocalPath $Path
    if(-not (Test-Path -LiteralPath $Path)){continue}
    if([IO.Path]::GetFullPath($Path).TrimEnd('\') -eq [IO.Path]::GetPathRoot($Path).TrimEnd('\')){throw 'ドライブ全体の Allow は解除対象外'}
    $Acl=[IO.Directory]::GetAccessControl($Path)
    foreach($Rule in @($Acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){if($Rule.IdentityReference.Value -eq $Sid.Value){[void]$Acl.RemoveAccessRuleSpecific($Rule)}}
    [IO.Directory]::SetAccessControl($Path,$Acl)
  }
}
if($State){
  $RuntimeRoot=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('Clodex-Sandbox-'+$HumanSid)
  Assert-LocalPath $RuntimeRoot
  if(Test-Path -LiteralPath $RuntimeRoot){
    $Acl=[IO.Directory]::GetAccessControl($RuntimeRoot,[Security.AccessControl.AccessControlSections]::Access)
    foreach($Rule in @($Acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){if($Rule.IdentityReference.Value -eq $State.agentSid -and $Rule.AccessControlType -eq 'Allow' -and $Rule.FileSystemRights -eq 'ReadAndExecute,Synchronize'){[void]$Acl.RemoveAccessRuleSpecific($Rule)}}
    [IO.Directory]::SetAccessControl($RuntimeRoot,$Acl)
  }
}
$AgentSid=if($User){$User.SID.Value}elseif($State){$State.agentSid}else{$null}
if($User){Remove-LocalUser -SID $User.SID}
Remove-AgentProfiles $AgentSid $HumanSid
$Key='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
if(Get-ItemProperty -LiteralPath $Key -Name 'clodex-agent' -ErrorAction SilentlyContinue){Remove-ItemProperty -LiteralPath $Key -Name 'clodex-agent'}
`;
