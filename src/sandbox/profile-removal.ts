export const profileRemovalSource = String.raw`
function Stop-AgentProcesses([string]$AgentSid) {
  foreach($Process in Get-CimInstance -ClassName Win32_Process){
    try{$Owner=Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -ErrorAction Stop}catch{continue}
    if($Owner.ReturnValue -ne 0 -or $Owner.Sid -ne $AgentSid){continue}
    $Result=Invoke-CimMethod -InputObject $Process -MethodName Terminate -ErrorAction Stop
    if($Result.ReturnValue -ne 0){
      if(Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId="+$Process.ProcessId)){throw ('agent プロセスの停止失敗: '+$Process.ProcessId)}
    }
  }
}
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
    Stop-AgentProcesses $Profile.SID
    $UnloadAttempts=10;$UnloadIntervalMs=500
    for($Attempt=0;$Profile.Loaded -and $Attempt -lt $UnloadAttempts;$Attempt++){
      Start-Sleep -Milliseconds $UnloadIntervalMs
      $Profile=Get-CimInstance -InputObject $Profile -ErrorAction Stop
    }
    if($Profile.Loaded){throw 'agent プロファイルが使用中。プロセス終了後に再実行'}
    Remove-CimInstance -InputObject $Profile -ErrorAction Stop
  }
}
`;
