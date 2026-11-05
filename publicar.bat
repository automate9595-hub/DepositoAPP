@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DepositoAPP - Instalacion y publicacion en GitHub
cd /d "%~dp0"
set "DEFAULT_REPO=github.com/automate9595-hub/DepositoAPP"

echo ==========================================================
echo   DepositoAPP - instalacion y publicacion en GitHub Pages
echo ==========================================================
echo.

rem ---------- 1. Git y Node.js ----------
echo [1/9] Verificando Git y Node.js...
where git >nul 2>&1
if errorlevel 1 ( set "MSG=Git no esta instalado. Descarguelo de https://git-scm.com/download/win y vuelva a ejecutar." & goto :fail )
where node >nul 2>&1
if errorlevel 1 ( set "MSG=Node.js no esta instalado. Descarguelo de https://nodejs.org ^(version LTS^) y vuelva a ejecutar." & goto :fail )
node -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)"
if errorlevel 1 ( set "MSG=Se necesita Node.js 18 o superior. Actualice desde https://nodejs.org" & goto :fail )
for /f "delims=" %%v in ('node -v') do echo       Node %%v
for /f "delims=" %%v in ('git --version') do echo       %%v

rem ---------- 2. Estructura ----------
echo [2/9] Verificando la estructura del proyecto...
for %%f in (package.json src\index.html src\sw.js scripts\check.mjs scripts\build.mjs supabase\01_esquema.sql supabase\02_funciones.sql supabase\03_seguridad.sql) do (
  if not exist "%%f" ( set "MSG=Falta el archivo %%f. Descomprima el ZIP completo y ejecute este archivo desde la carpeta del proyecto." & goto :fail )
)
echo       Estructura correcta.

rem ---------- 3. Dependencias ----------
echo [3/9] Instalando dependencias...
call npm install --no-audit --no-fund --no-package-lock --ignore-scripts >nul 2>&1
if errorlevel 1 ( echo       Aviso: npm install no pudo ejecutarse. El proyecto no tiene dependencias externas, se continua. ) else ( echo       Listo. )

rem ---------- 4. Configuracion de Supabase ----------
echo [4/9] Configuracion de Supabase...
set "KEEP_ENV=N"
if exist ".env" (
  choice /c SN /n /m "       Ya existe el archivo .env con su configuracion. Conservarlo? [S/N] "
  if not errorlevel 2 set "KEEP_ENV=S"
)
if /i "%KEEP_ENV%"=="S" goto :env_done
echo.
echo       Supabase ^> Project Settings ^> API
echo       Use la URL y la clave "anon public". NUNCA la clave service_role.
set "DEP_URL="
set "DEP_KEY="
set /p "DEP_URL=       URL del proyecto (https://xxxx.supabase.co): "
set /p "DEP_KEY=       Clave publica anon: "
set "DEP_OVERWRITE=1"
node scripts\configurar.mjs
if errorlevel 1 ( set "MSG=La configuracion de Supabase no es valida. Revise los datos e intente de nuevo." & goto :fail )
set "DEP_KEY="
:env_done

rem ---------- 5. Comprobaciones y compilacion ----------
echo [5/9] Ejecutando comprobaciones y pruebas...
node scripts\check.mjs
if errorlevel 1 ( set "MSG=Las comprobaciones fallaron. NO se publica nada. Corrija lo indicado arriba." & goto :fail )
echo [6/9] Compilando la aplicacion...
node scripts\build.mjs
if errorlevel 1 ( set "MSG=La compilacion fallo. NO se publica nada." & goto :fail )

rem ---------- 7. Repositorio ----------
echo [7/9] Repositorio de GitHub...
set "REPO_IN=%DEFAULT_REPO%"
set /p "REPO_IN=       Direccion del repositorio [%DEFAULT_REPO%]: "
set "REPO_URL="
for /f "usebackq tokens=1,2,3 delims=|" %%a in (`node scripts\repo.mjs "%REPO_IN%"`) do (
  set "REPO_URL=%%a"
  set "PAGES_URL=%%b"
  set "REPO_SLUG=%%c"
)
if not defined REPO_URL ( set "MSG=La direccion del repositorio no es valida. Ejemplo: github.com/usuario/repositorio" & goto :fail )
echo       Repositorio: %REPO_URL%

if not exist ".git" (
  git init >nul 2>&1
  if errorlevel 1 ( set "MSG=No se pudo inicializar Git." & goto :fail )
)
git checkout -B main >nul 2>&1

git config user.name >nul 2>&1
if errorlevel 1 (
  set "GIT_NAME="
  set /p "GIT_NAME=       Su nombre para los commits de Git: "
  if not defined GIT_NAME set "GIT_NAME=DepositoAPP"
  git config user.name "%GIT_NAME%"
)
git config user.email >nul 2>&1
if errorlevel 1 (
  set "GIT_MAIL="
  set /p "GIT_MAIL=       Su correo para los commits de Git: "
  if not defined GIT_MAIL set "GIT_MAIL=deposito@localhost"
  git config user.email "%GIT_MAIL%"
)

set "CUR_REMOTE="
for /f "delims=" %%r in ('git remote get-url origin 2^>nul') do set "CUR_REMOTE=%%r"
if not defined CUR_REMOTE (
  git remote add origin "%REPO_URL%"
) else if /i not "%CUR_REMOTE%"=="%REPO_URL%" (
  echo       El remoto origin actual es: %CUR_REMOTE%
  choice /c SN /n /m "       Reemplazarlo por la direccion indicada? [S/N] "
  if errorlevel 2 ( set "MSG=Operacion cancelada: el remoto existente no se modifico." & goto :fail )
  git remote set-url origin "%REPO_URL%"
)

rem Nunca subir secretos: .env debe estar ignorado
git ls-files --error-unmatch .env >nul 2>&1
if not errorlevel 1 ( set "MSG=El archivo .env esta versionado en Git. Ejecute: git rm --cached .env  y vuelva a intentar." & goto :fail )

echo       Consultando el repositorio remoto...
git ls-remote --heads origin > "%TEMP%\dep_remote.txt" 2> "%TEMP%\dep_remote_err.txt"
if errorlevel 1 (
  type "%TEMP%\dep_remote_err.txt"
  set "MSG=No se pudo acceder al repositorio. Verifique que exista, que tenga permisos y que haya iniciado sesion en GitHub." & goto :fail
)
findstr /c:"refs/heads/main" "%TEMP%\dep_remote.txt" >nul 2>&1
if not errorlevel 1 (
  echo       El repositorio YA tiene contenido en la rama main.
  echo       Se puede combinar con sus archivos, sin borrar nada. No se sobrescribe sin autorizacion.
  choice /c CX /n /m "       [C] Combinar y continuar   [X] Cancelar : "
  if errorlevel 2 ( set "MSG=Operacion cancelada. No se modifico nada en GitHub." & goto :fail )
  git add -A >nul 2>&1
  git commit -m "Version local antes de combinar" >nul 2>&1
  git pull origin main --no-rebase --allow-unrelated-histories --no-edit
  if errorlevel 1 (
    git merge --abort >nul 2>&1
    set "MSG=Hay conflictos al combinar con el contenido existente. Se cancelo la combinacion sin cambios; resuelva manualmente." & goto :fail
  )
)

rem ---------- 8. Subir ----------
echo [8/9] Subiendo archivos a GitHub...
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "DepositoAPP: publicacion %DATE% %TIME%" >nul
  if errorlevel 1 ( set "MSG=No se pudo crear el commit." & goto :fail )
) else (
  echo       No hay cambios nuevos para guardar.
)
git push -u origin main
if errorlevel 1 ( set "MSG=No se pudo subir a GitHub. Revise permisos o inicio de sesion. No se uso force push." & goto :fail )

rem ---------- 9. GitHub Pages ----------
echo [9/9] Configurando GitHub Pages...
set "PAGES_OK=0"
where gh >nul 2>&1
if not errorlevel 1 (
  gh auth status >nul 2>&1
  if not errorlevel 1 (
    gh api -X POST "repos/%REPO_SLUG%/pages" -f "source[branch]=main" -f "source[path]=/docs" >nul 2>&1 && set "PAGES_OK=1"
    if "%PAGES_OK%"=="0" gh api -X PUT "repos/%REPO_SLUG%/pages" -f "source[branch]=main" -f "source[path]=/docs" >nul 2>&1 && set "PAGES_OK=1"
  )
)
echo.
echo ==========================================================
echo   LISTO. Archivos subidos a %REPO_URL%
echo ==========================================================
if "%PAGES_OK%"=="1" (
  echo   GitHub Pages configurado. Puede tardar 1 a 3 minutos en estar disponible.
) else (
  echo   Falta activar GitHub Pages ^(una sola vez^):
  echo     1. Abra https://github.com/%REPO_SLUG%/settings/pages
  echo     2. Source: Deploy from a branch
  echo     3. Branch: main   Carpeta: /docs   ^> Save
)
echo.
echo   Direccion de la aplicacion: %PAGES_URL%
echo   En Android abra esa direccion en Chrome ^> menu ^> Instalar aplicacion.
echo.
pause
exit /b 0

:fail
echo.
echo ----------------------------------------------------------
echo   ERROR: %MSG%
echo ----------------------------------------------------------
echo.
pause
exit /b 1
