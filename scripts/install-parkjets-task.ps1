# =============================================================================
#  Parkjets Archive - install the Windows recovery scheduled task
# =============================================================================
#
#  Registers the scheduled task that resumes the migration after a crash, a
#  reboot or a power loss.
#
#  What it installs
#    Task name : ParkjetsArchiveRecovery  (override with -TaskName)
#    Action    : powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass
#                -WindowStyle Hidden -File scripts\resume-parkjets.ps1
#    Triggers  : at logon (delayed 1 minute) and once daily at 09:00 (+/- 30 min)
#    Settings  : StartWhenAvailable        -> a logon missed while the machine was
#                                            off is run as soon as it can be
#                MultipleInstances IgnoreNew -> overlapping triggers cannot stack
#                Run whether on battery or not
#                Restart up to 3 times, 5 minutes apart
#                6 hour execution limit
#
#  What it will never do
#    The task runs resume-parkjets.ps1, which exits immediately once
#    .migration/state.json reports the project complete. There is no separate
#    "disable the task" step and no way for it to relaunch a finished project.
#
#  Run as the user who should own the task. No administrator rights are needed
#  for a per-user at-logon trigger.
#
#    powershell -ExecutionPolicy Bypass -File scripts\install-parkjets-task.ps1
#    powershell -ExecutionPolicy Bypass -File scripts\install-parkjets-task.ps1 -Uninstall
#    powershell -ExecutionPolicy Bypass -File scripts\install-parkjets-task.ps1 -Status
# =============================================================================

[CmdletBinding()]
param(
  [string]$TaskName = 'ParkjetsArchiveRecovery',
  [switch]$Uninstall,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ResumeScript = Join-Path $ProjectRoot 'scripts\resume-parkjets.ps1'
$MigrateDir = Join-Path $ProjectRoot '.migration'

function Say { param([string]$m, [string]$c = 'Gray') Write-Host $m -ForegroundColor $c }

if (-not (Test-Path -LiteralPath $ResumeScript)) {
  Say "Cannot find $ResumeScript" 'Red'
  exit 1
}
New-Item -ItemType Directory -Force -Path $MigrateDir | Out-Null

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Say "Removed scheduled task '$TaskName'." 'Yellow'
  }
  else {
    Say "Scheduled task '$TaskName' was not registered."
  }
  exit 0
}

if ($Status) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { Say "Scheduled task '$TaskName' is NOT installed." 'Yellow'; exit 1 }
  Say "Scheduled task '$TaskName'" 'Cyan'
  Say "  State          : $($t.State)"
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Say "  Last run       : $($info.LastRunTime)"
  Say "  Last result    : $($info.LastTaskResult)"
  Say "  Next run       : $($info.NextRunTime)"
  Say '  Triggers:'
  foreach ($tr in $t.Triggers) { Say "    $($tr.CimClass.CimClassName)  $($tr.StartBoundary)" }
  Say '  Action:'
  foreach ($a in $t.Actions) { Say "    $($a.Execute) $($a.Arguments)" }
  exit 0
}

# --- preflight --------------------------------------------------------------
Say 'Preflight' 'Cyan'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Say "  node        : $($node.Source)" } else { Say '  node        : NOT FOUND (required)' 'Yellow' }
$oc = Get-Command opencode -ErrorAction SilentlyContinue
if ($oc) { Say "  opencode    : $($oc.Source)" } else { Say '  opencode    : NOT FOUND (recovery will not be able to launch an agent)' 'Yellow' }
$state = Join-Path $MigrateDir 'state.json'
if (Test-Path -LiteralPath $state) {
  $s = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json
  Say "  state       : $($s.status) (phase $($s.phase))"
}
else {
  Say '  state       : not initialised yet (will be created on first run)' 'Yellow'
}

# --- register ---------------------------------------------------------------
# -Execute must be the executable ALONE; the command line goes in -Argument.
# Passing the whole command line to -Execute makes Task Scheduler fail with
# 0x80070057 (ERROR_INVALID_PARAMETER) at run time.
$exe = 'powershell.exe'
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ResumeScript`""

$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT1M'
$daily = New-ScheduledTaskTrigger -Daily -At 9am
$daily.RandomDelay = 'PT30M'

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Say "Replacing the existing '$TaskName' task..." 'Yellow'
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

try {
  Register-ScheduledTask -TaskName $TaskName `
    -Description 'Resumes the Parkjets Archive migration after a crash or power loss. No-ops once the project is complete.' `
    -Action (New-ScheduledTaskAction -Execute $exe -Argument $arguments) `
    -Trigger @($logon, $daily) `
    -Settings $settings | Out-Null
}
catch {
  Say "Registration failed: $($_.Exception.Message)" 'Red'
  Say 'If this is a permissions problem, run the PowerShell window as Administrator once.' 'Yellow'
  exit 1
}

Say ''
Say "Installed scheduled task '$TaskName'." 'Green'
Say '  Runs at every logon (+1 min) and daily at 09:00 (+/- 30 min).'
Say '  Catches up if a logon was missed, and cannot stack duplicate runs.'
Say ''
Say 'Verify with:  powershell -ExecutionPolicy Bypass -File scripts\install-parkjets-task.ps1 -Status'
Say 'Test it with: powershell -ExecutionPolicy Bypass -File scripts\resume-parkjets.ps1 -DryRun'
Say 'Remove with:  powershell -ExecutionPolicy Bypass -File scripts\install-parkjets-task.ps1 -Uninstall'
exit 0
