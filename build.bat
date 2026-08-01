@echo off
setlocal enabledelayedexpansion
title Universal Freebie - Production Builder
cd /d "%~dp0"

echo ============================================================
echo    Universal Freebie - Production Builder
echo ============================================================
echo.

REM ---------- Prerequisites ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Please install it from https://nodejs.org
    echo         and make sure it is added to your PATH, then run this script again.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found. Please install Node.js and try again.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
for /f "delims=" %%v in ('npm -v') do set NPM_VER=%%v
echo   Node: %NODE_VER%   npm: %NPM_VER%
echo.

REM ---------- Mode selection ----------
set MODE=installer
if /i "%~1"=="dir" set MODE=dir
if /i "%~1"=="dir-only" set MODE=dir

echo [STEP 1/4] Installing dependencies...
if exist node_modules (
    echo   node_modules found - running "npm install" to sync...
    call npm install
) else (
    echo   Fresh install...
    call npm install
)
if errorlevel 1 goto :fail
echo.

echo [STEP 2/4] Building Next.js frontend (static export)...
call npm run build
if errorlevel 1 goto :fail
echo.

echo [STEP 3/4] Packaging Windows app...
if "%MODE%"=="dir" (
    echo   Mode: unpacked directory (dist/win-unpacked)
    call npm run package:dir
) else (
    echo   Mode: NSIS installer (dist/Universal Freebie Setup *.exe)
    call npm run package
)
if errorlevel 1 goto :fail
echo.

echo [STEP 4/4] Done!
echo.
echo   Output folder: %~dp0dist
echo   - Installer:   dist\Universal Freebie Setup *.exe
echo   - Unpacked:    dist\win-unpacked\Universal Freebie.exe
echo.
pause
exit /b 0

:fail
echo.
echo [BUILD FAILED] Something went wrong. Scroll up to see the error.
pause
exit /b 1
