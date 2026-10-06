<#
.EXAMPLE
  .\spikes\sandbox-user-setup.ps1 -Project E:\dev\clodex-sandbox-test -Artifacts "$env:USERPROFILE\.clodex\artifacts\sandbox-test"
.EXAMPLE
  .\spikes\sandbox-user-setup.ps1 -Uninstall
.EXAMPLE
  .\spikes\sandbox-user-setup.ps1 -Status
.EXAMPLE
  .\spikes\sandbox-user-setup.ps1 -Login
.NOTES
  普段のユーザーと同じアカウントで昇格した Windows PowerShell 5.1 から実行する。
  計測専用ディレクトリのみ指定する。CLI のログインと計測は別途実行する。
#>
[CmdletBinding()]
param([string]$Project, [string]$Artifacts, [switch]$Uninstall, [switch]$Status, [switch]$Login)

$ErrorActionPreference = 'Stop'
$AccountName = 'clodex-agent'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$HumanSid = $Identity.User
$ProfilePath = [Environment]::GetFolderPath('UserProfile')
$ClodexDir = Join-Path $ProfilePath '.clodex'
$CredentialPath = Join-Path $ClodexDir 'agent-credential'
$StatePath = Join-Path $ClodexDir 'sandbox-user-state.json'

if ($Status) {
    if ($Uninstall) { throw '-Status と -Uninstall は併用不可' }
    $Existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
    $HasCredential = Test-Path -LiteralPath $CredentialPath
    $HasState = Test-Path -LiteralPath $StatePath
    $Configured = $false
    if ($Existing -and $HasCredential -and $HasState) {
        try {
            $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
            $Configured = $State.complete -eq $true -and $State.humanSid -eq $HumanSid.Value -and $State.agentSid -eq $Existing.SID.Value -and $Existing.Enabled
        } catch { $Configured = $false }
    }
    @{ userExists = [bool]$Existing; credentialExists = $HasCredential; stateExists = $HasState; configured = [bool]$Configured } | ConvertTo-Json -Compress
    return
}

# パスワードは DPAPI にしか無く人は知らないため、CLI のログイン用に clodex-agent の PowerShell を開く
if ($Login) {
    if (-not (Test-Path -LiteralPath $StatePath)) { throw 'セットアップ未完了' }
    $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    $Secret = Get-Content -LiteralPath $CredentialPath -Raw | ConvertTo-SecureString
    $Credential = New-Object Management.Automation.PSCredential($AccountName, $Secret)
    Start-Process powershell.exe -Credential $Credential -LoadUserProfile -WorkingDirectory $State.project
    return
}

$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '管理者の PowerShell が必要' }
$RegisteredProfile = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($HumanSid.Value)").ProfileImagePath
if ([Environment]::ExpandEnvironmentVariables($RegisteredProfile) -ne $ProfilePath) { throw '普段のユーザーと同じアカウントで昇格が必要' }

function Get-SetupAction($State, $Agent, [bool]$HasCredential, [string]$OwnerSid, [string]$ProjectPath, [string]$ArtifactsPath) {
    if (-not $State -and -not $Agent -and -not $HasCredential) { return 'create' }
    if (-not $State -or -not $Agent -or -not $HasCredential -or $State.complete -ne $true) { throw 'セットアップ未完了。先に -Uninstall' }
    if ($State.humanSid -ne $OwnerSid -or $State.agentSid -ne $Agent.SID.Value) { throw 'セットアップの SID が不一致' }
    if (-not $Agent.Enabled) { throw '専用ユーザーが無効' }
    if ($State.project -ne $ProjectPath -or $State.artifacts -ne $ArtifactsPath) { throw 'セットアップ済みのパスと不一致' }
    return 'reuse'
}

function Set-PrivateFile([string]$Path, [string]$Content) {
    if (-not (Test-Path -LiteralPath $Path)) { [IO.File]::WriteAllText($Path, '') }
    $Acl = New-Object Security.AccessControl.FileSecurity
    $Acl.SetOwner($HumanSid)
    $Acl.SetAccessRuleProtection($true, $false)
    $Acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($HumanSid, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $Acl
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Assert-NoReparsePoint([string]$Path) {
    $Current = [IO.Path]::GetFullPath($Path)
    while ($Current) {
        if (Test-Path -LiteralPath $Current) {
            if ((Get-Item -LiteralPath $Current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "reparse point は指定不可: $Current"
            }
        }
        $Parent = [IO.Directory]::GetParent($Current)
        if ($null -eq $Parent) { break }
        $Current = $Parent.FullName
    }
}

function Test-Within([string]$Child, [string]$Parent) {
    return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Remove-AgentRules([string]$Path, [string]$Sid) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Assert-NoReparsePoint $Path
    $Acl = Get-Acl -LiteralPath $Path
    foreach ($Rule in $Acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
        if ($Rule.IdentityReference.Value -eq $Sid) { [void]$Acl.RemoveAccessRuleSpecific($Rule) }
    }
    Set-Acl -LiteralPath $Path -AclObject $Acl
}

function Get-DenyDriveRoots($Volumes, [string]$SystemDrive) {
    if ($SystemDrive -notmatch '^[A-Za-z]:\\?$') { throw 'システムドライブを判定不可' }
    $SystemRoot = $SystemDrive.TrimEnd('\') + '\'
    $Volumes | Where-Object { $_.DriveType -eq 'Fixed' -and [string]$_.DriveLetter -match '^[A-Za-z]$' } |
        ForEach-Object { ([string]$_.DriveLetter).ToUpperInvariant() + ':\' } |
        Where-Object { $_ -ne $SystemRoot } | Sort-Object -Unique
}

function New-DriveDenyRule([Security.Principal.SecurityIdentifier]$Sid) {
    return [Security.AccessControl.FileSystemAccessRule]::new($Sid, 'Write,Delete,DeleteSubdirectoriesAndFiles', 'ContainerInherit,ObjectInherit', 'None', 'Deny')
}

function Assert-DenyDriveRoot([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\$' -or $Path.TrimEnd('\') -eq $env:SystemDrive) { throw "Deny 対象外: $Path" }
    if (-not (Test-Path -LiteralPath $Path)) { throw "記録したドライブなし: $Path" }
    Assert-NoReparsePoint $Path
}

function Update-DriveDeny($State, [string[]]$Roots) {
    if (-not $State.PSObject.Properties['deniedDrives']) { $State | Add-Member -NotePropertyName deniedDrives -NotePropertyValue @() }
    $State.complete = $false
    Set-PrivateFile $StatePath ($State | ConvertTo-Json)
    $Rule = New-DriveDenyRule ([Security.Principal.SecurityIdentifier]::new($State.agentSid))
    if ($Roots.Count) { Write-Host 'ドライブ ACL の継承反映中… 全体走査に時間がかかる場合あり' }
    foreach ($Root in $Roots) {
        Assert-DenyDriveRoot $Root
        # 継承の反映途中で失敗しても、Uninstall で対象を追跡できるよう先に記録する。
        if ($State.deniedDrives -notcontains $Root) {
            $State.deniedDrives = @($State.deniedDrives) + $Root
            Set-PrivateFile $StatePath ($State | ConvertTo-Json)
        }
        $Acl = Get-Acl -LiteralPath $Root
        $Existing = @($Acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object {
            $_.IdentityReference.Value -eq $State.agentSid -and $_.AccessControlType -eq $Rule.AccessControlType -and
            $_.InheritanceFlags -eq $Rule.InheritanceFlags -and $_.PropagationFlags -eq $Rule.PropagationFlags -and
            ($_.FileSystemRights -band $Rule.FileSystemRights) -eq $Rule.FileSystemRights
        })
        if ($Existing.Count) { continue }
        $Acl.AddAccessRule($Rule)
        Set-Acl -LiteralPath $Root -AclObject $Acl
    }
    $State.complete = $true
    Set-PrivateFile $StatePath ($State | ConvertTo-Json)
}

function Remove-DriveDenyRules($State) {
    if (-not $State.deniedDrives) { return }
    Write-Host 'ドライブ ACL の継承解除中… 全体走査に時間がかかる場合あり'
    $Rule = New-DriveDenyRule ([Security.Principal.SecurityIdentifier]::new($State.agentSid))
    foreach ($Root in $State.deniedDrives) {
        Assert-DenyDriveRoot $Root
        $Acl = Get-Acl -LiteralPath $Root
        if ($Acl.RemoveAccessRule($Rule)) { Set-Acl -LiteralPath $Root -AclObject $Acl }
    }
}

Assert-NoReparsePoint $ClodexDir
Assert-NoReparsePoint $CredentialPath
Assert-NoReparsePoint $StatePath
if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $StatePath)) {
        if ((Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $CredentialPath)) { throw 'セットアップ記録なし' }
        Write-Output 'セットアップなし'
        return
    }
    $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ($State.humanSid -ne $HumanSid.Value) { throw 'セットアップしたユーザーで実行が必要' }
    $Existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
    if ($Existing -and $Existing.SID.Value -ne $State.agentSid) { throw 'アカウント SID が不一致' }
    Remove-DriveDenyRules $State
    foreach ($Path in $State.paths) { Remove-AgentRules $Path $State.agentSid }
    if ($Existing) { Remove-LocalUser -SID $Existing.SID }
    if (Test-Path -LiteralPath $CredentialPath) { Remove-Item -LiteralPath $CredentialPath }
    Remove-Item -LiteralPath $StatePath
    Write-Output '専用ユーザーと付与 ACL の除去完了（作成物とプロファイルは保持）'
    return
}

if (-not $Project -or -not $Artifacts) { throw '-Project と -Artifacts が必要' }
if ($Project -notmatch '^[A-Za-z]:\\' -or $Artifacts -notmatch '^[A-Za-z]:\\') { throw 'ローカルの絶対パスが必要' }
$Project = [IO.Path]::GetFullPath($Project).TrimEnd('\')
$Artifacts = [IO.Path]::GetFullPath($Artifacts).TrimEnd('\')
$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
foreach ($Protected in @($Repository, $ProfilePath)) {
    if ((Test-Within $Project $Protected) -or (Test-Within $Protected $Project)) { throw "計測専用 project が必要: $Project" }
}
if ($Project -eq [IO.Path]::GetPathRoot($Project).TrimEnd('\')) { throw 'ドライブ直下は指定不可' }
$ArtifactsRoot = Join-Path $ClodexDir 'artifacts'
if (-not (Test-Within $Artifacts $ArtifactsRoot) -or $Artifacts -eq $ArtifactsRoot) { throw 'artifacts の子ディレクトリが必要' }
foreach ($Path in @($Project, $Artifacts)) { Assert-NoReparsePoint $Path }
$Existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
$State = $null
if (Test-Path -LiteralPath $StatePath) { $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json }
$Action = Get-SetupAction $State $Existing (Test-Path -LiteralPath $CredentialPath) $HumanSid.Value $Project $Artifacts
$DenyRoots = @(Get-DenyDriveRoots (Get-Volume) $env:SystemDrive)
if ($Action -eq 'reuse') {
    Update-DriveDeny $State $DenyRoots
    Write-Output "セットアップ済み: $Project / $Artifacts"
    return
}
[void][IO.Directory]::CreateDirectory($ClodexDir)
foreach ($Path in @($Project, $Artifacts)) { [void][IO.Directory]::CreateDirectory($Path) }

$RandomBytes = New-Object byte[] 48
$Rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $Rng.GetBytes($RandomBytes) } finally { $Rng.Dispose() }
$Secret = ConvertTo-SecureString ('Aa1!' + [Convert]::ToBase64String($RandomBytes)) -AsPlainText -Force
[Array]::Clear($RandomBytes, 0, $RandomBytes.Length)
$Agent = New-LocalUser -Name $AccountName -Password $Secret -Description 'Clodex sandbox spike' -AccountNeverExpires
try {
    $State = [pscustomobject]@{ humanSid = $HumanSid.Value; agentSid = $Agent.SID.Value; paths = @($Project, $Artifacts); project = $Project; artifacts = $Artifacts; complete = $false; deniedDrives = @() }
    Set-PrivateFile $StatePath ($State | ConvertTo-Json)
    $Users = Get-LocalGroup -SID 'S-1-5-32-545'
    foreach ($Group in Get-LocalGroup) {
        $Member = Get-LocalGroupMember -Group $Group -ErrorAction Stop | Where-Object { $_.SID -eq $Agent.SID }
        if ($Member -and $Group.SID -ne $Users.SID) { Remove-LocalGroupMember -Group $Group -Member $Agent }
    }
    if (-not (Get-LocalGroupMember -Group $Users | Where-Object { $_.SID -eq $Agent.SID })) { Add-LocalGroupMember -Group $Users -Member $Agent }
    Set-PrivateFile $CredentialPath (ConvertFrom-SecureString $Secret)
    foreach ($Path in $State.paths) {
        $Acl = Get-Acl -LiteralPath $Path
        $Acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($Agent.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        Set-Acl -LiteralPath $Path -AclObject $Acl
    }
    Update-DriveDeny $State $DenyRoots
    Write-Output "セットアップ完了: $Project / $Artifacts"
} catch {
    Write-Warning 'セットアップ未完了。記録があれば -Uninstall で復旧'
    if (-not (Test-Path -LiteralPath $StatePath)) { Remove-LocalUser -SID $Agent.SID }
    throw
} finally { $Secret.Dispose() }
