# =============================================================================
#  Parkjets Archive - power-loss recovery / resume
# =============================================================================
#
#  Purpose
#    Windows can lose power mid-task. This script is the thing that picks the
#    project back up: at logon, or on demand, it inspects .migration/state.json
#    and either does nothing (project finished) or launches OpenCode once, in
#    automatic mode, with an instruction to continue the next outstanding task.
#
#  Guarantees
#    * NEVER starts a second OpenCode instance. Enforced two ways: an exclusive
#      lock file holding the running PID, and a process scan for any opencode
#      process already running. A crashed run leaves a stale lock, which is
#      detected and cleared.
#    * NEVER runs when the project is complete. Completion is read from
#      .migration/state.json (status == "completed") and cross-checked against
#      the task queue, so a state file that is stale or hand-edited cannot cause
#      an endless relaunch loop.
#    * NEVER destroys work. It runs `git status` for the record and refuses to
#      touch the working tree.
#    * Idempotent and safe to run repeatedly, including from a scheduled task
#      that fires on every logon.
#
#  Usage
#    powershell -ExecutionPolicy Bypass -File scripts\resume-parkjets.ps1
#    powershell -ExecutionPolicy Bypass -File scripts\resume-parkjets.ps1 -Status
#    powershell -ExecutionPolicy Bypass -File scripts\resume-parkjets.ps1 -Force
#    powershell -ExecutionPolicy Bypass -File scripts\resume-parkjets.ps1 -UninstallTask
#
#  Exit codes
#    0  nothing to do (already complete, or already running)
#    1  recovery launched, or an error occurred
# =============================================================================

[CmdletBinding()]
param(
  # Print the decision and exit without launching anything.
  [switch]$Status,
  # Launch even if the state says the project is complete (operator override).
  [switch]$Force,
  # Remove the scheduled task, then exit.
  [switch]$UninstallTask,
  # Register (or re-register) the Windows scheduled task, then exit.
  [switch]$InstallTask,
  # Scheduled task name to manage.
  [string]$TaskName = 'ParkjetsArchiveRecovery',
  # Run every step (guards, state refresh, prompt generation) but print the
  # command instead of starting it. Useful for verifying the wiring, and for
  # showing the operator exactly what would run.
  [switch]$DryRun,
  # Optional override for the OpenCode executable.
  [string]$OpenCodeExe = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MigrateDir = Join-Path $ProjectRoot '.migration'
$StateFile = Join-Path $MigrateDir 'state.json'
$QueueFile = Join-Path $MigrateDir 'queue.json'
$FailedFile = Join-Path $MigrateDir 'failed.json'
$LockFile = Join-Path $MigrateDir 'resume.lock'
$LogDir = Join-Path $MigrateDir 'logs'
$StateTool = Join-Path $ProjectRoot 'scripts\migration-state.mjs'

New-Item -ItemType Directory -Force -Path $MigrateDir, $LogDir | Out-Null

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = '[{0}] {1,-5} {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Add-Content -Path (Join-Path $LogDir ('resume-' + (Get-Date).ToString('yyyy-MM') + '.log')) -Value $line
  Write-Host $line
}

# -----------------------------------------------------------------------------
# 1. Does the project already have a complete migration?
# -----------------------------------------------------------------------------
function Get-MigrationDecision {
  if (-not (Test-Path -LiteralPath $StateFile)) {
    return @{ Action = 'init'; Reason = 'no .migration/state.json yet - initialising from repository evidence' }
  }

  $state = $null
  try { $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json }
  catch { return @{ Action = 'repair'; Reason = "state.json is unreadable ($($_.Exception.Message))" } }

  $queue = $null
  if (Test-Path -LiteralPath $QueueFile) {
    try { $queue = Get-Content -LiteralPath $QueueFile -Raw | ConvertFrom-Json } catch { }
  }

  $failed = $null
  if (Test-Path -LiteralPath $FailedFile) {
    try { $failed = Get-Content -LiteralPath $FailedFile -Raw | ConvertFrom-Json } catch { }
  }

  $pending = @()
  if ($queue -and $queue.tasks) { $pending = @($queue.tasks | Where-Object { -not $_.done }) }
  $unresolved = @()
  if ($failed -and $failed.tasks) { $unresolved = @($failed.tasks | Where-Object { $_.recovered -eq $false }) }

  if ($state.status -eq 'completed' -and $pending.Count -eq 0 -and $unresolved.Count -eq 0) {
    return @{ Action = 'complete'; Reason = "migration marked completed at commit $($state.finalCommit)" }
  }
  if ($state.status -eq 'completed' -and ($pending.Count -gt 0 -or $unresolved.Count -gt 0)) {
    return @{
      Action = 'resume'
      Reason = "state says completed but $($pending.Count) task(s) and $($unresolved.Count) failure(s) are still open - treating as incomplete"
      Pending = $pending
    }
  }

  $next = $null
  if ($pending.Count -gt 0) { $next = $pending[0] }
  $retry = @($unresolved | Where-Object { $_.recoverable -ne $false })
  if ($retry.Count -gt 0) {
    return @{
      Action = 'resume'
      Reason = "$($retry.Count) recoverable failure(s) to retry; $($pending.Count) task(s) pending"
      Pending = $pending
      Retry = $retry
    }
  }
  return @{
    Action = 'resume'
    Reason = "$($pending.Count) task(s) pending"
    Pending = $pending
  }
}

# -----------------------------------------------------------------------------
# 2. Single-instance enforcement
# -----------------------------------------------------------------------------
function Test-ProcessAlive {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $false }
  try { $null = Get-Process -Id $ProcessId -ErrorAction Stop; return $true }
  catch { return $false }
}

function Get-OtherOpenCodeProcesses {
  $self = $PID
  $found = @()
  foreach ($p in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^opencode' })) {
    if ($p.Id -ne $self) { $found += $p }
  }
  return $found
}

function Clear-StaleLock {
  if (-not (Test-Path -LiteralPath $LockFile)) { return $null }
  $lock = $null
  try { $lock = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json } catch { }
  if ($lock -and $lock.pid -and (Test-ProcessAlive -ProcessId ([int]$lock.pid))) {
    return $lock
  }
  Write-Log "clearing stale lock from a process that is no longer running (pid $($lock.pid))" 'WARN'
  Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
  return $null
}

function New-Lock {
  $lock = [pscustomobject]@{
    pid     = $PID
    owner   = "resume-parkjets/$($env:USERNAME)"
    started = (Get-Date).ToString('o')
  }
  $lock | ConvertTo-Json | Set-Content -LiteralPath $LockFile -Encoding utf8
  return $lock
}

# -----------------------------------------------------------------------------
# 3. Locate the OpenCode executable
# -----------------------------------------------------------------------------
function Resolve-OpenCode {
  if ($OpenCodeExe -and (Test-Path -LiteralPath $OpenCodeExe)) { return $OpenCodeExe }
  $cmd = Get-Command opencode -ErrorAction SilentlyContinue
  if ($cmd) {
    foreach ($ext in @('opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode.ps1')) {
      $candidate = Join-Path (Split-Path -Parent $cmd.Source) $ext
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $cmd.Source
  }
  foreach ($guess in @(
      "$env:APPDATA\npm\opencode.cmd",
      "$env:ProgramFiles\nodejs\opencode.cmd",
      "$env:LOCALAPPDATA\Programs\nodejs\opencode.cmd")) {
    if (Test-Path -LiteralPath $guess) { return $guess }
  }
  return $null
}

# -----------------------------------------------------------------------------
# 4. Build the instruction handed to OpenCode
# -----------------------------------------------------------------------------
function Get-ResumePrompt {
  param($Decision)
  $pending = @()
  if ($Decision.ContainsKey('Pending')) { $pending = @($Decision.Pending) }
  $lines = New-Object System.Collections.Generic.List[string]

  $lines.Add('You are resuming the Parkjets Archive project after an interrupted or crashed run.')
  $lines.Add('')
  $lines.Add('This is a RESUME, not a restart. The archive is already built and committed.')
  $lines.Add('DO NOT recreate the repository, re-run aircraft discovery, re-download media, discard')
  $lines.Add('commits, discard uncommitted changes, or reset the working tree. The existing work')
  $lines.Add('is the source of truth.')
  $lines.Add('')
  $lines.Add('Repository:  C:\Users\eagleanurag\Documents\parkjets')
  $lines.Add('Work in that directory. Read .migration/state.json first.')
  $lines.Add('')
  $lines.Add('WORKFLOW - repeat this cycle until every task is done:')
  $lines.Add('  1. node scripts/migration-state.mjs show')
  $lines.Add('  2. node scripts/migration-state.mjs next      # the single next task')
  $lines.Add('  3. node scripts/migration-state.mjs begin <id>')
  $lines.Add('  4. Do the work. Do not weaken a failing test to make it pass.')
  $lines.Add('  5. node scripts/migration-state.mjs done <id> "<evidence>"')
  $lines.Add('     or  node scripts/migration-state.mjs fail <id> "<reason>"   then continue')
  $lines.Add('        with independent work and return to it later.')
  $lines.Add('  6. git add -A; git commit -m "<message>"   # checkpoint every unit')
  $lines.Add('  7. node scripts/migration-state.mjs checkpoint "<reason>"')
  $lines.Add('')
  $lines.Add('QUALITY GATES (all must pass before the project is complete):')
  $lines.Add('  npm run validate        # data integrity, duplicates, missing images, broken downloads')
  $lines.Add('  npm test                # 29 integrity tests')
  $lines.Add('  npm run build           # validate + astro build')
  $lines.Add('  npm run check-links     # post-build link / asset / alt / ARIA audit')
  $lines.Add('  npm run audit           # payload + accessibility audit')
  $lines.Add('  npm run qa              # browser matrix, 8 viewports')
  $lines.Add('  npm run qa -- --url https://eagleanurag.github.io/parkjet-aircraft-archive --shots')
  $lines.Add('')
  $lines.Add('RULES')
  $lines.Add('  * Never fabricate aircraft data. A specification is recorded only when the')
  $lines.Add('    designer wrote it. Silent or ambiguous sources are shown verbatim.')
  $lines.Add('  * Never add a download button that would not work. Plan files on parkjets.com')
  $lines.Add('    are MemberSpace-gated; those records stay SOURCE_ONLY with a source link.')
  $lines.Add('    If a file is placed in public/plans/<slug>/, npm run archive validates it and')
  $lines.Add('    the button switches to a real download automatically.')
  $lines.Add('  * Never bypass authentication, CAPTCHA, payment, DRM or any access control.')
  $lines.Add('  * Never commit secrets, tokens or cookies.')
  $lines.Add('  * Do not stop after one task. Work through the queue autonomously.')
  $lines.Add('')
  $lines.Add('COMPLETION')
  $lines.Add('  When every task is done and the gates pass:')
  $lines.Add('    node scripts/migration-state.mjs complete')
  $lines.Add('  Then stop. Do not relaunch yourself.')

  if ($pending.Count -gt 0) {
    $lines.Add('')
    $lines.Add('OUTSTANDING TASKS (from .migration/queue.json):')
    foreach ($t in $pending) { $lines.Add(("  - {0}: {1}" -f $t.id, $t.title)) }
  }
  return ($lines -join [Environment]::NewLine)
}

# -----------------------------------------------------------------------------
# 5. Scheduled task management
# -----------------------------------------------------------------------------
function Install-RecoveryTask {
  $self = $PSCommandPath
  # -Execute must be the executable ALONE; the command line goes in -Argument.
  $exe = 'powershell.exe'
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`""
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # Catch a logon that happened while the machine was off, and a missed
  # trigger after a crash, without ever launching a duplicate.
  $trigger.Delay = 'PT1M'
  $trigger2 = New-ScheduledTaskTrigger -Daily -At 9am
  $trigger2.RandomDelay = 'PT30M'
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)

  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  Register-ScheduledTask -TaskName $TaskName `
    -Description 'Resumes the Parkjets Archive migration after a crash or power loss. No-ops once the project is complete.' `
    -Action (New-ScheduledTaskAction -Execute $exe -Argument $arguments) `
    -Trigger @($trigger, $trigger2) `
    -Settings $settings | Out-Null
  Write-Log "installed scheduled task '$TaskName'" 'OK'
}

function Uninstall-RecoveryTask {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Log "removed scheduled task '$TaskName'" 'OK'
  }
  else {
    Write-Log "scheduled task '$TaskName' was not registered" 'WARN'
  }
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------
try {
  if ($UninstallTask) { Uninstall-RecoveryTask; exit 0 }
  if ($InstallTask) { Install-RecoveryTask; exit 0 }

  Set-Location $ProjectRoot
  Write-Log "resume check in $ProjectRoot"

  # --- record the working tree without ever changing it ---------------------
  $dirty = @(git status --porcelain 2>$null)
  Write-Log ("git {0} - {1} uncommitted path(s) (left untouched)" -f (git rev-parse --short HEAD), $dirty.Count)

  $decision = Get-MigrationDecision
  Write-Log "decision: $($decision.Action) - $($decision.Reason)"

  if ($Status) {
    if (Test-Path -LiteralPath $StateTool) { & node $StateTool show }
    Write-Host "  (Status only - nothing was launched.)`n"
    exit 0
  }

  if ($decision.Action -eq 'complete' -and -not $Force) {
    Write-Log 'project is complete - not launching OpenCode' 'OK'
    Write-Host "  Nothing to do. Parkjets Archive migration is complete."
    Write-Host "  Use -Force to override.`n"
    exit 0
  }

  # --- single-instance guards ------------------------------------------------
  # Each guard records a verdict. In a dry run the guards are reported rather
  # than obeyed, so the wiring can be verified on a machine where OpenCode is
  # already open (which is the normal case during development).
  $guards = @()

  $lock = Clear-StaleLock
  if ($lock) {
    Write-Log "another resume run is active (pid $($lock.pid)) - not launching" 'WARN'
    $guards += "BLOCKED: another resume run is active (pid $($lock.pid))"
    if (-not $DryRun) {
      Write-Host "  Already running (pid $($lock.pid)). Nothing to do.`n"
      exit 0
    }
  }
  else { $guards += 'passed: no live lock file' }

  $others = Get-OtherOpenCodeProcesses
  if ($others.Count -gt 0) {
    $ids = ($others | ForEach-Object { $_.Id }) -join ', '
    Write-Log "OpenCode is already running (pid: $ids) - not launching a duplicate" 'WARN'
    $guards += "BLOCKED: OpenCode already running (pid: $ids)"
    if (-not $DryRun) {
      Write-Host "  OpenCode already running (pid: $ids). Nothing to do.`n"
      exit 0
    }
  }
  else { $guards += 'passed: no other OpenCode process' }

  $exe = Resolve-OpenCode
  if (-not $exe) {
    Write-Log 'could not locate the opencode executable - see scripts\resume-parkjets.ps1 in the README' 'ERROR'
    Write-Host "  Could not find `opencode` on PATH. Install it or pass -OpenCodeExe <path>.`n"
    exit 1
  }

  # --- (re)create the state if the file is missing or broken ----------------
  if ($decision.Action -in @('init', 'repair')) {
    Write-Log "running migration-state init ($($decision.Action))"
    & node $StateTool init | Out-Null
    $decision = Get-MigrationDecision
  }

  $prompt = Get-ResumePrompt -Decision $decision
  $promptFile = Join-Path $LogDir 'resume-prompt.txt'
  Set-Content -LiteralPath $promptFile -Value $prompt -Encoding utf8
  Write-Log "resume prompt written to $promptFile"

  $argList = @('run', '--auto', '--title', 'parkjets-recovery', $prompt)

  if ($DryRun) {
    Write-Host ''
    Write-Host '  DRY RUN - nothing was started. This is what would run:'
    Write-Host "    cwd     : $ProjectRoot"
    Write-Host "    exe     : $exe"
    Write-Host "    args    : run --auto --title parkjets-recovery <prompt>"
    Write-Host "    prompt  : $promptFile ($((Get-Item $promptFile).Length) bytes, $((Get-Content $promptFile).Count) lines)"
    Write-Host ''
    Write-Host '  Single-instance guards:'
    foreach ($g in $guards) { Write-Host "    $g" }
    Write-Host ''
    $blocked = @($guards | Where-Object { $_ -like 'BLOCKED*' })
    if ($blocked.Count -gt 0) {
      Write-Host "  A REAL RUN RIGHT NOW WOULD NOT LAUNCH ($($blocked.Count) guard(s) blocking)." -ForegroundColor Yellow
    }
    else {
      Write-Host '  A real run right now WOULD launch.' -ForegroundColor Green
    }
    Write-Host ''
    exit 1
  }

  $null = New-Lock
  Write-Log "launching: $exe $($argList[0..3] -join ' ') (full log: $LogDir)"

  $stdout = Join-Path $LogDir 'opencode-stdout.log'
  $stderr = Join-Path $LogDir 'opencode-stderr.log'
  $p = Start-Process -FilePath $exe `
    -ArgumentList $argList `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

  Write-Log "OpenCode started (pid $($p.Id))" 'OK'
  Write-Host "  Parkjets recovery started (pid $($p.Id))."
  Write-Host "  Output: $stdout`n"
  exit 1
}
catch {
  Write-Log "fatal: $($_.Exception.Message)" 'ERROR'
  Write-Host "  Recovery script error: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
