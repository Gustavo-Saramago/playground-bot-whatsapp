@echo off
setlocal
cd /d "%~dp0"
echo Ligando bot em modo de teste...
powershell -ExecutionPolicy Bypass -File ".\scripts\bot-test-on.ps1"
echo.
pause