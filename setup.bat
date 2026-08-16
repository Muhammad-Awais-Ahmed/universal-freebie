@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1

REM ============================================================
REM  Universal Freebie - New Release Builder
REM  Usage: setup.bat [version]
REM    version  optional semver, e.g. setup.bat 1.2.0
REM ============================================================

set "ROOT=%~dp0"
cd /d "%ROOT%" || exit /b 1

echo ============================================================
echo   Universal Freebie - New Release Builder
echo ============================================================
echo.

REM ---------- Read current version ----------
set "CUR_VER=1.0.0"
if exist package.json (
    for /f "tokens=* usebackq" %%V in (`node -e "try{console.log(require('./package.json').version)}catch(e){}" 2^>nul`) do (
        if not "%%V"=="" set "CUR_VER=%%V"
    )
)
echo   Current version: %CUR_VER%
echo.

REM ---------- Ask for new version (optional) ----------
set "NEW_VER=%~1"
if not defined NEW_VER (
    set /p "NEW_VER=Enter new version (leave blank to keep %CUR_VER%): "
)
if not defined NEW_VER (
    echo   Keeping current version: %CUR_VER%
    goto :clean
)
echo   Setting version to !NEW_VER!...
call npm version !NEW_VER! --no-git-tag-version --allow-same-version
if errorlevel 1 (
    echo [ERROR] Failed to set version. Make sure it is a valid semver (e.g. 1.2.0).
    pause
    exit /b 1
)

:clean
echo.
echo [1/4] Cleaning previous build artifacts...
if exist dist rmdir /s /q dist
if exist out rmdir /s /q out
if exist node_modules\.cache rmdir /s /q node_modules\.cache
echo   Done.

echo.
echo [2/4] Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

echo.
echo [3/4] Building Next.js static export...
call npm run build
if errorlevel 1 (
    echo [ERROR] Next.js build failed.
    pause
    exit /b 1
)

echo.
echo [4/4] Packaging Electron installer (NSIS)...
call npm run package
if errorlevel 1 (
    echo [ERROR] Packaging failed.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Release build complete!
echo   Installer: dist\Universal Freebie Setup %CUR_VER%.exe
echo ============================================================
pause
endlocal
exit /b 0
