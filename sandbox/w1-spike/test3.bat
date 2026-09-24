@echo off
REM Milestone 3: real overlay semantics.
REM   - read of a workspace-only file falls through (sees the lead's version)
REM   - write is isolated: the real workspace file never changes
REM   - the write lands in the overlay and reads back there
REM   - a brand-new file is created in the overlay, not the workspace
REM Writes are driven by node INSIDE the sandbox (not shell `>`, which the
REM outer batch would execute un-sandboxed). Overlay state persists between
REM launches, modelling an agent that edits then runs against what it edited.
setlocal
cd /d "%~dp0"

if not exist sandbox-launch.exe ( echo Build first: build.bat & exit /b 1 )

set "WS=%~dp0ws3"
set "OV=%~dp0overlay3"
set "LOG=%~dp0run3.log"
if exist "%WS%" rmdir /s /q "%WS%"
if exist "%OV%" rmdir /s /q "%OV%"
if exist "%LOG%" del "%LOG%"
mkdir "%WS%"
> "%WS%\hello.txt" echo WORKSPACE ORIGINAL

set "CEREBRILINE_WS_ROOT=%WS%"
set "CEREBRILINE_OVERLAY_ROOT=%OV%"

echo === A. read a workspace-only file under sandbox (expect: WORKSPACE ORIGINAL) ===
sandbox-launch.exe hook.dll "%LOG%" cmd /c type "%WS%\hello.txt"

echo === A2. overlay must still be empty after a pure read (expect: overlay-empty OK) ===
if exist "%OV%\hello.txt" (echo FAIL: read copied into overlay) else (echo overlay-empty OK)

echo === B. write to the workspace path under sandbox (node, in-sandbox) ===
sandbox-launch.exe hook.dll "%LOG%" node -e "require('fs').writeFileSync(String.raw`%WS%\hello.txt`,'AGENT EDIT')"

echo === B1. real workspace file must be UNCHANGED (expect: WORKSPACE ORIGINAL) ===
type "%WS%\hello.txt"

echo === B2. overlay now holds the edit (expect: AGENT EDIT) ===
if exist "%OV%\hello.txt" (type "%OV%\hello.txt" & echo.) else (echo FAIL: overlay has no hello.txt)

echo === B3. read back under sandbox sees the edit (expect: AGENT EDIT) ===
sandbox-launch.exe hook.dll "%LOG%" node -e "process.stdout.write(require('fs').readFileSync(String.raw`%WS%\hello.txt`,'utf8'))"
echo.

echo === C. create a brand-new nested file under sandbox (node, in-sandbox) ===
sandbox-launch.exe hook.dll "%LOG%" node -e "require('fs').mkdirSync(String.raw`%WS%\sub`,{recursive:true});require('fs').writeFileSync(String.raw`%WS%\sub\created.txt`,'BRAND NEW')"

echo === C1. workspace must NOT have it (expect: ws-clean OK) ===
if exist "%WS%\sub\created.txt" (echo FAIL: new file hit the workspace) else (echo ws-clean OK)

echo === C2. overlay HAS it (expect: BRAND NEW) ===
if exist "%OV%\sub\created.txt" (type "%OV%\sub\created.txt" & echo.) else (echo FAIL: overlay has no created.txt)

echo.
echo === changed files in the overlay (this is the agent's handback set) ===
powershell -NoProfile -Command "$ov='%OV%'; Get-ChildItem -Recurse -File $ov | ForEach-Object { $_.FullName.Substring($ov.Length) }"
endlocal
