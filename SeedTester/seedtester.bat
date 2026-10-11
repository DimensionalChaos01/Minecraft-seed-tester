@echo off
rem Seed Tester launcher.
rem   Double-click            -> runs config.json from this folder
rem   Drop a .json file on it -> runs that config instead
rem   seedtester.bat selftest -> checks the engine against cubiomes
setlocal
title Seed Tester
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
set "SEEDTESTER_OPEN=1"
if "%~1"=="" goto default_config
node src\cli.js %*
goto finished

:default_config
node src\cli.js config.json

:finished
echo.
pause
exit /b %errorlevel%

:install_failed
echo.
echo The download failed. Check your internet connection and run this file again.
pause
exit /b 1
