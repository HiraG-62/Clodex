param([switch]$DefineOnly)

function Set-SandboxAgentEnvironment {
    $AgentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $AgentProfile = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$AgentSid" -ErrorAction Stop).ProfileImagePath
    $AgentProfile = [Environment]::ExpandEnvironmentVariables($AgentProfile)
    if ($AgentProfile -notmatch '^[A-Za-z]:\\.+') { throw '専用ユーザーのプロファイルを判定不可' }
    $env:USERPROFILE = $AgentProfile
    $env:HOMEDRIVE = $AgentProfile.Substring(0, 2)
    $env:HOMEPATH = $AgentProfile.Substring(2)
    $env:APPDATA = "$AgentProfile\AppData\Roaming"
    $env:LOCALAPPDATA = "$AgentProfile\AppData\Local"
    $env:TEMP = "$AgentProfile\AppData\Local\Temp"
    $env:TMP = $env:TEMP
    foreach ($Directory in @($env:APPDATA, $env:TEMP)) { [void][IO.Directory]::CreateDirectory($Directory) }
    $env:Path = "$AgentProfile\.local\bin;$env:APPDATA\npm;" + [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $env:PSModulePath = "$AgentProfile\Documents\WindowsPowerShell\Modules;$env:ProgramFiles\WindowsPowerShell\Modules;" + [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
    Remove-Item Env:HOME -ErrorAction SilentlyContinue
}

if (-not $DefineOnly) {
    Set-SandboxAgentEnvironment
    "clodex-agent: $env:USERPROFILE"
}
