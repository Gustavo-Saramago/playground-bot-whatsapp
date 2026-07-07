@echo off
setlocal
cd /d "%~dp0"
echo Ligando bot...
powershell -ExecutionPolicy Bypass -File ".\scripts\bot-on.ps1"
echo.
pause
