@echo off
REM =============================================================================
REM  Parkjets Archive - one-click recovery
REM =============================================================================
REM  Double-click this file after a crash, power loss or reboot to pick the
REM  migration back up. It is a thin wrapper around resume-parkjets.ps1 so the
REM  real logic stays in one place.
REM
REM  Usage:
REM    resume-parkjets.cmd            attempt recovery
REM    resume-parkjets.cmd status     show the decision, launch nothing
REM    resume-parkjets.cmd install    register the Windows scheduled task
REM    resume-parkjets.cmd uninstall  remove the scheduled task
REM =============================================================================
setlocal
set "PS1=%~dp0resume-parkjets.ps1"
if not exist "%PS1%" (
  echo Could not find "%PS1%".
  pause
  exit /b 1
)

set "FLAG=%~1"
if "%FLAG%"==""   set "FLAG="
if "%FLAG%"=="status"    set "FLAG=-Status"
if "%FLAG%"=="install"   set "FLAG=-InstallTask"
if "%FLAG%"=="uninstall" set "FLAG=-UninstallTask"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %FLAG%
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Recovery script finished.
) else (
  echo Recovery script exited with code %RC%.
  echo   0 = nothing to do ^(complete, or already running^)
  echo   1 = recovery launched, or an error occurred - see .migration\logs\
)
echo.
pause
exit /b %RC%
