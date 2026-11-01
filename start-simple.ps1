#!/usr/bin/env pwsh
# Script simple para iniciar Cartera Dashboard
# Cierra todos los procesos automáticamente al terminar

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "CARTERA DASHBOARD - INICIANDO" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# 1. Limpiar procesos previos
Write-Host "Limpiando procesos previos..." -ForegroundColor Yellow
Get-Process node, electron, powershell -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq "powershell" -and $_.Id -ne $PID } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process node, electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 2. Iniciar servidor Vite en background job
Write-Host "Iniciando servidor Vite..." -ForegroundColor Cyan
$viteJob = Start-Job -ScriptBlock {
  cd C:\Proyectos\Zenith-Cartera
  & pnpm dev:renderer 2>&1 | Out-Null
} -Name "ViteServer"

Start-Sleep -Seconds 8

# 3. Compilar Electron
Write-Host "Compilando Electron..." -ForegroundColor Cyan
cd C:\Proyectos\Zenith-Cartera
pnpm exec tsc -p tsconfig.node.json 2>&1 | Out-Null
pnpm exec vite build --config electron.vite.config.ts --logLevel silent 2>&1 | Out-Null

Start-Sleep -Seconds 3

# 4. Lanzar aplicación
Write-Host "Lanzando aplicacion..." -ForegroundColor Green
Write-Host ""

$env:VITE_DEV_SERVER_URL = "http://localhost:5173"
& ./node_modules/.bin/electron .

# 5. Limpiar todo al cerrar
Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "Aplicacion cerrada" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Limpiando procesos..." -ForegroundColor Yellow

# Cerrar job de Vite
if ($viteJob) {
  Stop-Job -Job $viteJob -ErrorAction SilentlyContinue
  Remove-Job -Job $viteJob -ErrorAction SilentlyContinue
}

# Cerrar todos los procesos de Node y Electron
Get-Process node, electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Cerrar otras ventanas de PowerShell
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "Procesos cerrados" -ForegroundColor Green
Start-Sleep -Seconds 1

# Cerrar esta ventana
exit
