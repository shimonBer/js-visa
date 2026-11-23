@echo off
REM Opens fill-ds160. This file is in the zip. It does not download anything.
setlocal EnableExtensions
cd /d "%~dp0"

call :findnode
if not defined NODEEXE goto :nonode

for %%D in ("%NODEEXE%") do set "PATH=%%~dpD;%PATH%"

if not exist "%~dp0node_modules\playwright\package.json" goto :needdownload

"%NODEEXE%" "%~dp0scripts\fill-ui\server.js" --open
if errorlevel 1 goto :fail
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
echo Then double-click Download fill-ds160.bat in this folder.
echo.
pause
exit /b 1

:needdownload
echo fill-ds160 is not downloaded yet.
echo Double-click Download fill-ds160.bat in this folder and leave that window open until it finishes.
echo Then double-click fill-ds160.bat again.
echo.
pause
exit /b 1

:fail
echo.
echo fill-ds160 did not start. Read the messages above.
echo.
pause
exit /b 1
