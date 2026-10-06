$P = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)").ProfileImagePath
$env:USERPROFILE = $P; $env:HOMEDRIVE = $P.Substring(0, 2); $env:HOMEPATH = $P.Substring(2)
$env:APPDATA = "$P\AppData\Roaming"; $env:LOCALAPPDATA = "$P\AppData\Local"
$env:TEMP = "$P\AppData\Local\Temp"; $env:TMP = $env:TEMP
foreach ($D in @($env:APPDATA, $env:TEMP)) { [void][IO.Directory]::CreateDirectory($D) }
$env:Path = "$P\.local\bin;$env:APPDATA\npm;" + [Environment]::GetEnvironmentVariable('Path', 'Machine')
$env:PSModulePath = "$P\Documents\WindowsPowerShell\Modules;$env:ProgramFiles\WindowsPowerShell\Modules;" + [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
Remove-Item Env:HOME -ErrorAction SilentlyContinue
"clodex-agent: $P"
