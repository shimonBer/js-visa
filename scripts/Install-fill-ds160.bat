@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

echo.
echo fill-ds160 download
echo This window downloads packages and Chromium. It does not open the app.
echo Leave it open until it says the download is ready.
echo.

call :findnode
if not defined NODEEXE goto :nonode

for %%D in ("%NODEEXE%") do set "PATH=%%~dpD;%PATH%"

"%NODEEXE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)"
if errorlevel 1 goto :oldnode

echo Node:
"%NODEEXE%" -v
echo.

echo Installing packages...
call npm install
if errorlevel 1 goto :fail

echo.
echo Installing Chromium...
call npx playwright install chromium
if errorlevel 1 goto :playwrightfail

echo.
echo Download is ready.
echo Open the app by double-clicking fill-ds160.bat in this folder.
echo Google Chrome should be installed for the visa site. Chromium is only a fallback.
echo.
pause
exit /b 0

:findnode
set "NODEEXE="
where node >nul 2>&1
if errorlevel 1 goto :findnode_fallback
for /f "delims=" %%I in ('where node') do (
  set "NODEEXE=%%I"
  goto :findnode_done
)
:findnode_fallback
if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if defined NODEEXE goto :findnode_done
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODEEXE goto :findnode_done
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"
:findnode_done
exit /b 0

:nonode
echo Node.js was not found.
echo Install Node 20 LTS from https://nodejs.org
echo Then double-click Download fill-ds160.bat again.
echo.
pause
exit /b 1

:oldnode
echo Node 20 or newer is required. Install it from https://nodejs.org and run this again.
echo.
pause
exit /b 1

:playwrightfail
echo.
echo Chromium did not install. Check the internet connection, then double-click Download fill-ds160.bat again.
echo.
pause
exit /b 1

:fail
echo.
echo Download failed. Read the messages above, then double-click Download fill-ds160.bat again.
echo.
pause
exit /b 1
