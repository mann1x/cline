@echo off
REM Cerebriline sandbox W1 spike — build on Windows with MSVC + Microsoft Detours.
REM Run from a plain cmd; it locates and enters the VS build environment itself.
REM
REM   build.bat
REM
REM Produces, in this folder:
REM   Detours\           (cloned + built once; MIT)
REM   hook.dll           the injected file-open hook (observe-only, milestone 1)
REM   sandbox-launch.exe the launcher
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM --- Enter the x64 build environment ---------------------------------------
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath`) do set "VSPATH=%%i"
if "%VSPATH%"=="" (
  echo ERROR: Visual Studio not found via vswhere.
  exit /b 1
)
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 ( echo ERROR: vcvars64 failed & exit /b 1 )

REM --- Fetch Detours once (MIT) ----------------------------------------------
if not exist "Detours\.git" (
  if exist "Detours" rmdir /s /q Detours
  echo Cloning Microsoft Detours...
  git clone --depth 1 https://github.com/microsoft/Detours.git Detours || ( echo ERROR: clone failed & exit /b 1 )
)

REM Headers ship in src\ (nmake would copy them to include\; we skip nmake).
set "DET_INC=%~dp0Detours\src"
set "DET_LIB=%~dp0Detours\lib.X64"

REM --- Build the Detours static lib directly with cl (avoids its nmake) -------
REM disasm.cpp #includes the per-arch disol*.cpp, so five TUs make the lib.
if not exist "%DET_LIB%\detours.lib" (
  echo Building Detours static lib...
  if not exist "%DET_LIB%" mkdir "%DET_LIB%"
  pushd Detours\src
  cl /nologo /c /EHsc /O2 /MT /W3 /DWIN32_LEAN_AND_MEAN /I"%DET_INC%" ^
     detours.cpp modules.cpp disasm.cpp image.cpp creatwth.cpp || ( echo ERROR: Detours compile failed & popd & exit /b 1 )
  lib /nologo /OUT:"%DET_LIB%\detours.lib" detours.obj modules.obj disasm.obj image.obj creatwth.obj || ( echo ERROR: Detours lib failed & popd & exit /b 1 )
  del *.obj >nul 2>&1
  popd
)

REM --- Build the hook DLL ----------------------------------------------------
echo Building hook.dll...
cl /nologo /LD /EHsc /O2 /MT /I"%DET_INC%" hook.cpp /Fe:hook.dll /link /DEF:hook.def "%DET_LIB%\detours.lib" || ( echo ERROR: hook.dll build failed & exit /b 1 )

REM --- Build the launcher ----------------------------------------------------
echo Building sandbox-launch.exe...
cl /nologo /EHsc /O2 /MT /I"%DET_INC%" launcher.cpp /Fe:sandbox-launch.exe /link "%DET_LIB%\detours.lib" || ( echo ERROR: launcher build failed & exit /b 1 )

echo.
echo OK: hook.dll and sandbox-launch.exe built in %~dp0
endlocal
