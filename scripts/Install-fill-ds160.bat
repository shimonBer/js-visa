@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."
set "REPO=%CD%"

where node >nul 2>&1
if errorlevel 1 goto :nonode

node -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)"
if errorlevel 1 goto :oldnode

for /f "delims=" %%I in ('where node') do set "NODEEXE=%%I" & goto :gotnode
:gotnode

if not exist "node_modules\" (
  echo Installing packages...
  call npm install
  if errorlevel 1 goto :fail
)

echo Installing Chromium fallback...
call npx playwright install chromium

echo.
echo Google Chrome should be installed for CEAC. Playwright Chromium is only a fallback.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-fill-shortcut.ps1" -Repo "%REPO%" -NodeExe "%NODEEXE%"
if errorlevel 1 goto :fail

echo.
echo Shortcut is on the Desktop: fill-ds160
echo Double-click fill-ds160. Same Hebrew play/stop window as Mac.
echo.
pause
exit /b 0

:nonode
echo Node.js was not found. Install Node 20 LTS from https://nodejs.org then run this again.
echo.
pause
exit /b 1

:oldnode
echo Node 20 or newer is required.
echo.
pause
exit /b 1

:fail
echo.
echo Install failed. Read the messages above.
echo.
pause
exit /b 1
