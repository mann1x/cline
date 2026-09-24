@echo off
REM Milestone 2: redirect the workspace root to the agent's overlay.
REM A file exists in both, with different contents. Reading it through the
REM WORKSPACE path must return the OVERLAY contents -- and the command must
REM not be able to tell. Proven for `type` (direct child) and node (grandchild).
setlocal
cd /d "%~dp0"

if not exist sandbox-launch.exe ( echo Build first: build.bat & exit /b 1 )

set "WS=%~dp0ws"
set "OV=%~dp0overlay"
set "LOG=%~dp0run2.log"
if exist "%WS%" rmdir /s /q "%WS%"
if exist "%OV%" rmdir /s /q "%OV%"
if exist "%LOG%" del "%LOG%"
mkdir "%WS%"  & mkdir "%WS%\sub"
mkdir "%OV%"  & mkdir "%OV%\sub"

REM Distinct contents in each layer.
> "%WS%\hello.txt"      echo WORKSPACE VERSION -- the lead's file, must NOT be seen
> "%OV%\hello.txt"      echo OVERLAY VERSION -- the agent's private copy
> "%WS%\sub\deep.txt"   echo WORKSPACE deep
> "%OV%\sub\deep.txt"   echo OVERLAY deep

REM The DLL reads these; they are inherited by every process in the tree.
set "CEREBRILINE_WS_ROOT=%WS%"
set "CEREBRILINE_OVERLAY_ROOT=%OV%"

echo === A. baseline: `type` WITHOUT the sandbox (expect WORKSPACE) ===
type "%WS%\hello.txt"

echo === B. `type` through the workspace path UNDER sandbox (expect OVERLAY) ===
sandbox-launch.exe hook.dll "%LOG%" cmd /c type "%WS%\hello.txt"

echo === C. nested path under sandbox (expect OVERLAY deep) ===
sandbox-launch.exe hook.dll "%LOG%" cmd /c type "%WS%\sub\deep.txt"

echo === D. grandchild: node reads the workspace path (expect OVERLAY) ===
sandbox-launch.exe hook.dll "%LOG%" cmd /c "node -e \"process.stdout.write(require('fs').readFileSync(String.raw`%WS%\hello.txt`,'utf8'))\""

echo.
echo === REDIRECT lines logged (proves the rewrite fired, and to where) ===
powershell -NoProfile -Command "Get-Content '%LOG%' | Where-Object { $_ -match 'REDIRECT' } | Select-Object -First 8"
endlocal
