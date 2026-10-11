@echo off
rem Seed Tester interactive map: opens a draggable, zoomable biome map in your browser.
rem Keep this window open while you use the map. Close it to stop.
setlocal
title Seed Tester map
cd /d "%~dp0"

where node >nul 2>nul
if not errorlevel 1 goto have_node
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto have_node
echo Node.js was not found on this computer.
echo Install the LTS version from https://nodejs.org and run this file again.
echo.
pause
exit /b 1

:have_node
if exist "node_modules\deepslate\package.json" goto run
echo First run: downloading the two libraries Seed Tester needs. This takes a minute...
call npm install --no-fund --no-audit
if errorlevel 1 goto install_failed
echo.

:run
node src\cli.js map config.json %*
echo.
pause
exit /b %errorlevel%

:install_failed
echo.
echo The download failed. Check your internet connection and run this file again.
pause
exit /b 1
