@echo off
REM Abre el servidor y el tunel de Cloudflare con un solo doble clic (Windows).
REM Si existe "iniciar.bat" (tu copia con la clave), lo usa; si no, arranca sin buscador.
REM Requiere Node.js y cloudflared (winget install Cloudflare.cloudflared).
title Sincro
cd /d "%~dp0"

if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm install
)

if exist iniciar.bat (
  start "Sincro - servidor (no cerrar)" cmd /k iniciar.bat
) else (
  start "Sincro - servidor (no cerrar)" cmd /k npm start
)

timeout /t 3 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunel.ps1"

echo.
echo El tunel se cerro. Para apagar todo, cerra tambien la ventana del servidor.
pause
