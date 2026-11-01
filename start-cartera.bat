@echo off
setlocal enabledelayedexpansion

REM Script para iniciar automáticamente Cartera Dashboard con Cloudflare Tunnel
REM Coloca este archivo en: C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup

echo [%date% %time%] Iniciando Cartera Dashboard...

REM Navega a la carpeta del proyecto
cd /d "C:\Proyectos\Zenith-Cartera"

REM Verifica que Node.js y pnpm estén disponibles
where pnpm >nul 2>nul
if errorlevel 1 (
    echo Error: pnpm no está instalado o no está en PATH
    pause
    exit /b 1
)

REM Inicia el servidor Vite en background
start "Cartera Vite Dev Server" cmd /c "pnpm dev:renderer"
timeout /t 5 /nobreak

REM Inicia Electron
set VITE_DEV_SERVER_URL=http://localhost:5173
start "Cartera Dashboard" cmd /c "pnpm dev:electron"

echo [%date% %time%] Cartera Dashboard iniciado
echo Verifica http://localhost:3000 o https://0ebbb202-30f1-42a5-82b8-2d78ad402d5a.cfargotunnel.com

REM Mantiene el script abierto durante 10 segundos (opcional)
timeout /t 10
