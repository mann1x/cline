@echo off
REM Milestone 4c: rename is isolated. Renaming a workspace file under the
REM sandbox must leave the real workspace untouched, move the file inside the
REM overlay, whiteout the old name, and show only the new name in listings.
setlocal
cd /d "%~dp0"
if not exist sandbox-launch.exe ( echo Build first: build.bat & exit /b 1 )

set "WS=%~dp0ws6"
set "OV=%~dp0overlay6"
set "LOG=%~dp0run6.log"
if exist "%WS%" rmdir /s /q "%WS%"
if exist "%OV%" rmdir /s /q "%OV%"
if exist "%LOG%" del "%LOG%"
mkdir "%WS%"
> "%WS%\old.txt" echo OLDCONTENT

set "CEREBRILINE_WS_ROOT=%WS%"
set "CEREBRILINE_OVERLAY_ROOT=%OV%"
set "N=sandbox-launch.exe hook.dll %LOG% node -e"

echo === rename old.txt -^> new.txt under sandbox ===
%N% "require('fs').renameSync(String.raw`%WS%\old.txt`,String.raw`%WS%\new.txt`)"

echo === real workspace unchanged (expect: only old.txt) ===
dir /b "%WS%"

echo === overlay holds new.txt and a whiteout for old.txt ===
powershell -NoProfile -Command "$o='%OV%'; Get-ChildItem -Force -Recurse -File $o | ForEach-Object { $_.FullName.Substring($o.Length) }"

echo === listing under sandbox (expect: new.txt, NOT old.txt) ===
%N% "console.log(require('fs').readdirSync(String.raw`%WS%`).sort().join(','))"

echo === under sandbox: exists(old)=false exists(new)=true, read new=OLDCONTENT ===
%N% "const fs=require('fs');process.stdout.write('old='+fs.existsSync(String.raw`%WS%\old.txt`)+' new='+fs.existsSync(String.raw`%WS%\new.txt`)+' content='+fs.readFileSync(String.raw`%WS%\new.txt`,'utf8').trim())"
echo.
endlocal
