@echo off
setlocal
title DepositoAPP - Subir a GitHub
cd /d "%~dp0"
if not exist "scripts\subir.ps1" (
  echo ERROR: No se encuentra scripts\subir.ps1. Descomprima el ZIP completo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\subir.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo Si el problema persiste, copie el mensaje de ERROR y envielo para revisarlo.
pause
exit /b %RC%
