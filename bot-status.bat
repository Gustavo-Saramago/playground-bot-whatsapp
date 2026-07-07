@echo off
setlocal
cd /d "%~dp0"
echo Consultando status do bot...
powershell -ExecutionPolicy Bypass -File ".\scripts\bot-status.ps1"
echo.
pause
