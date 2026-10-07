# ClodexSpike の確認ダイアログを探し、「更新」のボタンを押す。
param([int]$TimeoutSec = 60)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  $pids = @(Get-Process clodex-gui -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ClodexSpike*' } | ForEach-Object Id)
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($pids -notcontains $w.Current.ProcessId -or $w.Current.ClassName -ne '#32770') { continue }
    $text = ($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name }) -join ' | '
    Write-Output "dialog: $text"
    $button = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -eq '更新' } | Select-Object -First 1
    Write-Output "click: $($button.Current.Name) $($button.Current.ControlType.ProgrammaticName)"
    # TaskDialog のボタンは Invoke に対応しないため、既定のボタン（更新）を Enter で押す。
    $button.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
Write-Output 'dialog not found'
exit 1
