@echo off
REM Milestone 1 smoke test: run commands under the hook and show what it logged.
REM Proves (a) injection works, (b) grandchildren are covered, (c) real tools
REM (node, git) run unmodified while every file open is observed.
setlocal
cd /d "%~dp0"

if not exist sandbox-launch.exe ( echo Build first: build.bat & exit /b 1 )

set "LOG=%~dp0run.log"
if exist "%LOG%" del "%LOG%"

echo === 1. cmd -^> whoami (basic injection) ===
sandbox-launch.exe hook.dll "%LOG%" cmd /c whoami

echo === 2. cmd -^> node (grandchild: cmd -^> node reads a file) ===
sandbox-launch.exe hook.dll "%LOG%" cmd /c "node -e \"require('fs').readFileSync(process.env.SystemRoot + '\\\\win.ini')\""

echo === 3. git status (a real multi-process tool) ===
sandbox-launch.exe hook.dll "%LOG%" cmd /c "git --version"

echo.
echo === distinct PIDs seen in the log (grandchildren => more than one) ===
powershell -NoProfile -Command "Get-Content '%LOG%' | ForEach-Object { ($_ -split \"`t\")[0] } | Sort-Object -Unique"

echo.
echo === sample of logged opens (first 20 lines) ===
powershell -NoProfile -Command "Get-Content '%LOG%' -TotalCount 20"

echo.
echo === total opens logged ===
powershell -NoProfile -Command "(Get-Content '%LOG%').Count"
endlocal
