#!/usr/bin/env pwsh
# Script para iniciar Cartera Dashboard en desarrollo
# Cierra automáticamente todos los procesos al terminar

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CARTERA DASHBOARD - INICIANDO" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Detener procesos previos si existen
Get-Process node, electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "1️⃣  Iniciando servidor Vite..." -ForegroundColor Yellow
$viteJob = Start-Job -ScriptBlock {
  cd C:\Proyectos\Zenith-Cartera
  & pnpm dev:renderer
}

Write-Host ""
Write-Host "Esperando que Vite esté listo..." -ForegroundColor Cyan
Start-Sleep -Seconds 8

Write-Host ""
Write-Host "2️⃣  Compilando Electron..." -ForegroundColor Yellow

# Compilar electron
cd C:\Proyectos\Zenith-Cartera
pnpm exec tsc -p tsconfig.node.json

Write-Host ""
Write-Host "3️⃣  Creando build de Electron..." -ForegroundColor Yellow
pnpm exec vite build --config electron.vite.config.ts --logLevel silent

Write-Host ""
Write-Host "Esperando que todo esté listo..." -ForegroundColor Cyan
Start-Sleep -Seconds 5

Write-Host ""
Write-Host "4️⃣  Lanzando Electron..." -ForegroundColor Yellow
$env:VITE_DEV_SERVER_URL = "http://localhost:5173"
& ./node_modules/.bin/electron .

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  ✅ APLICACIÓN CERRADA" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

# LIMPIAR: Cerrar todos los procesos relacionados
Write-Host ""
Write-Host "🧹 Limpiando procesos..." -ForegroundColor Yellow
Start-Sleep -Seconds 1

# Detener el job de Vite
if ($viteJob) {
  Stop-Job -Job $viteJob -ErrorAction SilentlyContinue
  Remove-Job -Job $viteJob -ErrorAction SilentlyContinue
}

# Cerrar todos los procesos de node y electron
Get-Process node, electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Cerrar las ventanas de PowerShell abiertas (excepto la actual)
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "✅ Procesos limpios, cerrando..." -ForegroundColor Green
Start-Sleep -Seconds 2

# Cerrar la ventana actual
exit
