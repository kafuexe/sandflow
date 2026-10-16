@echo off
rem Build the Sandflow Windows installer (Sandflow Setup x.y.z.exe) into release\.
rem Usage: scripts\compile-windows.bat   (double-click works too)
setlocal

cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required: https://nodejs.org
  goto :fail
)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22+ is required.
  goto :fail
)
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v
echo ==^> Building Sandflow %VERSION% for Windows

echo ==^> Installing dependencies
call npm ci
if errorlevel 1 goto :fail

echo ==^> Building the app and installer
call npm run app:dist -- --win
if errorlevel 1 goto :fail

echo.
echo ==^> Done. Output in release\:
dir /b release\*.exe
pause
exit /b 0

:fail
echo.
echo Build failed.
pause
exit /b 1
