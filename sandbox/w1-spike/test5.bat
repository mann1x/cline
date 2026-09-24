@echo off
REM Milestone 4b: directory-listing merge.
REM Workspace has a,b,c. Under the sandbox we edit b (copy-up), create d
REM (overlay-only), and delete c (whiteout). A listing must then show
REM a, b, d and NOT c, and must not leak the .wh.c.txt tombstone.
setlocal
cd /d "%~dp0"
if not exist sandbox-launch.exe ( echo Build first: build.bat & exit /b 1 )

set "WS=%~dp0ws5"
set "OV=%~dp0overlay5"
set "LOG=%~dp0run5.log"
if exist "%WS%" rmdir /s /q "%WS%"
if exist "%OV%" rmdir /s /q "%OV%"
if exist "%LOG%" del "%LOG%"
mkdir "%WS%"
> "%WS%\a.txt" echo A
> "%WS%\b.txt" echo B
> "%WS%\c.txt" echo C

set "CEREBRILINE_WS_ROOT=%WS%"
set "CEREBRILINE_OVERLAY_ROOT=%OV%"
set "N=sandbox-launch.exe hook.dll %LOG% node -e"

echo === mutate under sandbox: edit b, create d, delete c ===
%N% "require('fs').writeFileSync(String.raw`%WS%\b.txt`,'B-EDIT')"
%N% "require('fs').writeFileSync(String.raw`%WS%\d.txt`,'D-NEW')"
%N% "require('fs').unlinkSync(String.raw`%WS%\c.txt`)"

echo === raw overlay contents (should be b.txt, d.txt, .wh.c.txt) ===
powershell -NoProfile -Command "$o='%OV%'; Get-ChildItem -Force -Recurse -File $o | ForEach-Object { $_.FullName.Substring($o.Length) }"

echo === node readdir under sandbox (expect: a.txt,b.txt,d.txt) ===
%N% "console.log(require('fs').readdirSync(String.raw`%WS%`).sort().join(','))"

echo === cmd `dir /b` under sandbox (expect: a.txt b.txt d.txt, no c, no .wh) ===
sandbox-launch.exe hook.dll "%LOG%" cmd /c dir /b "%WS%"

echo === content check under sandbox: a=A (workspace), b=B-EDIT (overlay) ===
%N% "const fs=require('fs');process.stdout.write('a='+fs.readFileSync(String.raw`%WS%\a.txt`,'utf8').trim()+' b='+fs.readFileSync(String.raw`%WS%\b.txt`,'utf8').trim())"
echo.

echo === real workspace is intact (expect: a.txt b.txt c.txt) ===
dir /b "%WS%"
endlocal
