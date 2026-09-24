@echo off
REM Milestone 4a: deletes become whiteouts; stat/exists honour the overlay.
setlocal
cd /d "%~dp0"
if not exist sandbox-launch.exe ( echo Build first: build.bat & exit /b 1 )

set "WS=%~dp0ws4"
set "OV=%~dp0overlay4"
set "LOG=%~dp0run4.log"
if exist "%WS%" rmdir /s /q "%WS%"
if exist "%OV%" rmdir /s /q "%OV%"
if exist "%LOG%" del "%LOG%"
mkdir "%WS%"
> "%WS%\keep.txt"   echo KEEP
> "%WS%\doomed.txt" echo DOOMED

set "CEREBRILINE_WS_ROOT=%WS%"
set "CEREBRILINE_OVERLAY_ROOT=%OV%"
set "N=sandbox-launch.exe hook.dll %LOG% node -e"

echo === delete doomed.txt under sandbox (node unlink) ===
%N% "require('fs').unlinkSync(String.raw`%WS%\doomed.txt`)"

echo === real workspace doomed.txt must SURVIVE (expect: DOOMED) ===
type "%WS%\doomed.txt"

echo === overlay carries a whiteout tombstone (expect: .wh.doomed.txt) ===
powershell -NoProfile -Command "$o='%OV%'; Get-ChildItem -Force -Recurse -File $o | ForEach-Object { $_.FullName.Substring($o.Length) }"

echo === exists(doomed) under sandbox must be FALSE (whiteout via stat hook) ===
%N% "process.stdout.write('doomed exists='+require('fs').existsSync(String.raw`%WS%\doomed.txt`))"
echo.

echo === exists(keep) under sandbox must be TRUE, and read KEEP ===
%N% "process.stdout.write('keep exists='+require('fs').existsSync(String.raw`%WS%\keep.txt`)+' content='+require('fs').readFileSync(String.raw`%WS%\keep.txt`,'utf8').trim())"
echo.

echo === re-create doomed.txt under sandbox (node write) ===
%N% "require('fs').writeFileSync(String.raw`%WS%\doomed.txt`,'REBORN')"

echo === read doomed under sandbox must be REBORN, exists TRUE ===
%N% "process.stdout.write('exists='+require('fs').existsSync(String.raw`%WS%\doomed.txt`)+' content='+require('fs').readFileSync(String.raw`%WS%\doomed.txt`,'utf8'))"
echo.

echo === real workspace doomed.txt STILL unchanged (expect: DOOMED) ===
type "%WS%\doomed.txt"

echo === overlay: whiteout gone, doomed.txt = REBORN ===
powershell -NoProfile -Command "$o='%OV%'; Get-ChildItem -Force -Recurse -File $o | ForEach-Object { $_.FullName.Substring($o.Length) }"
endlocal
