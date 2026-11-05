@echo off
setlocal
chcp 65001 >nul
title DepositoAPP - Subir a GitHub sin Node.js
cd /d "%~dp0"
echo ==================================================
echo   DEPOSITOAPP - PUBLICACION SIN NODE.JS
echo ==================================================
echo.
echo La aplicacion ya esta preparada en la carpeta docs.
echo Este proceso NO necesita Node.js ni Git en Windows.
echo.
if not exist "docs\index.html" (
  echo ERROR: No se encuentra docs\index.html.
  pause
  exit /b 1
)
echo Se abrira la carpeta del proyecto y el repositorio de GitHub.
echo En GitHub, suba TODO el contenido de esta carpeta y pulse Commit changes.
echo El workflow publicara automaticamente la carpeta docs.
echo.
start "" explorer "%~dp0"
start "" "https://github.com/automate9595-hub/DepositoAPP"
echo.
echo IMPORTANTE: En GitHub, Settings ^> Pages, seleccione
echo Source: GitHub Actions. Esto se hace una sola vez.
echo Luego revise la pestana Actions para ver la publicacion.
pause
