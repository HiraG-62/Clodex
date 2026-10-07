export const profileRemovalSource = String.raw`
function Remove-AgentProfiles([string]$AgentSid,[string]$HumanSid) {
  $ProfileList='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
  $Expected=[IO.Path]::GetFullPath((Join-Path $env:SystemDrive 'Users\clodex-agent')).TrimEnd('\')
  $Targets=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  if($AgentSid){[void]$Targets.Add($AgentSid)}
  $ExistingSids=@(Get-LocalUser | ForEach-Object {$_.SID.Value})
  foreach($Entry in Get-ChildItem -LiteralPath $ProfileList){
    $Image=(Get-ItemProperty -LiteralPath $Entry.PSPath).ProfileImagePath
    if(-not $Image){continue}
    $Path=[IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Image)).TrimEnd('\')
    if($Path -eq $Expected -and $Entry.PSChildName -notin $ExistingSids){[void]$Targets.Add($Entry.PSChildName)}
  }
  foreach($Profile in Get-CimInstance -ClassName Win32_UserProfile){
    if(-not $Targets.Contains($Profile.SID)){continue}
    if($Profile.SID -eq $HumanSid -or $Profile.Special){throw '削除対象外のプロファイル'}
    if($Profile.Loaded){throw 'agent プロファイルが使用中。プロセス終了後に再実行'}
    Remove-CimInstance -InputObject $Profile -ErrorAction Stop
  }
}
`;
