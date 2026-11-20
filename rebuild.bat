@echo off
REM Pond - rebuild and restart: stop server on port 8787, syntax-check all modules, start fresh.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "KILLED=0"
echo [Pond] Stopping anything listening on port 8787...
for /f "tokens=5" %%a in ('netstat -ano -p TCP ^| findstr /R /C:":8787 .*LISTENING"') do (
  if not "%%a"=="0" (
    echo   killing PID %%a
    taskkill /PID %%a /T /F >nul 2>&1
    set "KILLED=1"
  )
)
if "!KILLED!"=="1" ping -n 2 127.0.0.1 >nul

echo [Pond] Checking syntax...
node --check server.js
if errorlevel 1 goto :syntax_err
for %%f in (lib\*.js) do (
  node --check "%%f"
  if errorlevel 1 goto :syntax_err
)

echo [Pond] Starting Pond on http://localhost:8787 (Ctrl+C to stop)
node server.js
exit /b %errorlevel%

:syntax_err
echo [Pond] Syntax error - not starting. Fix the error above and re-run.
exit /b 1
