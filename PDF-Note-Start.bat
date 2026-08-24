@echo off
setlocal

rem ============================================================
rem  PDF Note launcher (Chrome / Edge)
rem  - Put this file in the SAME folder as index.html.
rem  - Double-click to start.
rem  - Copies the app to %LOCALAPPDATA%\PDFNote\app and opens it
rem    with a dedicated, persistent browser profile, so the data
rem    folder permission is remembered and your normal browser
rem    is not affected.
rem ============================================================

set "SRC=%~dp0"
set "DST=%LOCALAPPDATA%\PDFNote\app"
set "PROFILE=%LOCALAPPDATA%\PDFNote\profile"

if not exist "%SRC%index.html" goto nofiles

if not exist "%DST%" mkdir "%DST%" >nul 2>nul
xcopy "%SRC%*" "%DST%\" /E /I /Y /Q >nul
if not exist "%DST%\index.html" goto copyfail

set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER goto nobrowser

start "" "%BROWSER%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check "%DST%\index.html"
exit /b 0

:nobrowser
echo.
echo [Error] Google Chrome / Microsoft Edge was not found.
echo Please install Chrome or Edge, then double-click this file again.
echo   Chrome: https://www.google.com/chrome/
echo.
pause
exit /b 1

:nofiles
echo.
echo [Error] Put this launcher in the SAME folder as index.html.
echo Current folder: %SRC%
echo.
pause
exit /b 1

:copyfail
echo.
echo [Error] Failed to copy the app to the local folder.
echo Check write permission for %LOCALAPPDATA%.
echo.
pause
exit /b 1
