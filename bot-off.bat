@echo off
setlocal
cd /d "%~dp0"
echo Desligando bot...
powershell -ExecutionPolicy Bypass -File ".\scripts\bot-off.ps1"
echo.
pause
