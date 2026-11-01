param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = node -p "require('./package.json').version"

if ([string]::IsNullOrWhiteSpace($version)) {
    throw "No se pudo leer la version de package.json."
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $root "release\v$version"
}


Write-Host ""
Write-Host "=== ZENITH CARTERA USB RELEASE v$version ===" `
    -ForegroundColor Cyan


# ------------------------------------------------------------
# 1. VALIDACION GENERAL
# ------------------------------------------------------------

Write-Host ""
Write-Host "=== VALIDATE ===" -ForegroundColor Cyan

pnpm validate

if ($LASTEXITCODE -ne 0) {
    throw "pnpm validate fallo."
}


# ------------------------------------------------------------
# 2. PROYECTO SIN DATASETS LOCALES
# ------------------------------------------------------------

Write-Host ""
Write-Host "=== PRE-BUILD DATA GATE ===" -ForegroundColor Cyan

pnpm installer:verify-clean

if ($LASTEXITCODE -ne 0) {
    throw "Validacion previa del instalador fallo."
}


# ------------------------------------------------------------
# 3. CONSTRUIR INSTALADOR
# ------------------------------------------------------------

Write-Host ""
Write-Host "=== BUILD INSTALLER ===" -ForegroundColor Cyan

pnpm build:installer

if ($LASTEXITCODE -ne 0) {
    throw "La construccion del instalador fallo."
}


# ------------------------------------------------------------
# 4. AUDITAR WIN-UNPACKED + APP.ASAR
# ------------------------------------------------------------

Write-Host ""
Write-Host "=== PACKAGED ISOLATION ===" -ForegroundColor Cyan

pnpm run verify:packaged-isolation

if ($LASTEXITCODE -ne 0) {
    throw "El paquete Electron contiene datos o artefactos QA."
}


# ------------------------------------------------------------
# 5. LOCALIZAR INSTALADOR EXACTO
# ------------------------------------------------------------

$expectedName = "Zenith Cartera Setup $version.exe"
$installer = Join-Path $root "release\$expectedName"

if (-not (Test-Path $installer)) {
    throw "No se encontro el instalador esperado: $installer"
}


# ------------------------------------------------------------
# 6. CREAR DIRECTORIO DE DISTRIBUCION
# ------------------------------------------------------------

if (Test-Path $OutputDirectory) {
    Remove-Item `
        $OutputDirectory `
        -Recurse `
        -Force
}

New-Item `
    -ItemType Directory `
    -Path $OutputDirectory `
    -Force |
Out-Null


# ------------------------------------------------------------
# 7. COPIAR INSTALADOR
# ------------------------------------------------------------

$targetInstaller = Join-Path `
    $OutputDirectory `
    $expectedName

Copy-Item `
    $installer `
    $targetInstaller `
    -Force


# ------------------------------------------------------------
# 8. COPIAR DOCUMENTACION USB
# ------------------------------------------------------------

$readmeSource = Join-Path `
    $root `
    "docs\ACTUALIZACION-PENDRIVE.md"

if (Test-Path $readmeSource) {

    Copy-Item `
        $readmeSource `
        (Join-Path $OutputDirectory "LEEME-ACTUALIZACION.md") `
        -Force
}


# ------------------------------------------------------------
# 9. SHA-256
# ------------------------------------------------------------

$hash = Get-FileHash `
    -Path $targetInstaller `
    -Algorithm SHA256

"$($hash.Hash)  $expectedName" |
Set-Content `
    (Join-Path $OutputDirectory "SHA256SUMS.txt") `
    -Encoding ASCII


# ------------------------------------------------------------
# 10. MANIFIESTO RELEASE
# ------------------------------------------------------------

$fileInfo = Get-Item $targetInstaller

$manifest = [ordered]@{
    product             = "Zenith Cartera"
    version             = $version
    installer           = $expectedName
    sha256              = $hash.Hash
    sizeBytes           = $fileInfo.Length
    generatedAt         = (Get-Date).ToString("o")
    updateMode          = "OFFLINE_USB_IN_PLACE"
    databaseLocation    = "%APPDATA%\cartera-dashboard\data\cartera.db"
    packagedData        = $false
    packagedQaFixtures  = $false
}

$manifest |
ConvertTo-Json -Depth 5 |
Set-Content `
    (Join-Path $OutputDirectory "release-manifest.json") `
    -Encoding UTF8


# ------------------------------------------------------------
# 11. RESULTADO
# ------------------------------------------------------------

Write-Host ""
Write-Host "==============================================" `
    -ForegroundColor Green

Write-Host "ZENITH CARTERA RELEASE GENERADO CORRECTAMENTE" `
    -ForegroundColor Green

Write-Host "==============================================" `
    -ForegroundColor Green

Write-Host ""
Write-Host "Directorio:" -ForegroundColor Cyan
Write-Host $OutputDirectory

Write-Host ""
Write-Host "Instalador:" -ForegroundColor Cyan
Write-Host $targetInstaller

Write-Host ""
Write-Host "SHA256:" -ForegroundColor Cyan
Write-Host $hash.Hash

Write-Host ""
Write-Host "BD empaquetada: NO" -ForegroundColor Green
Write-Host "Fixtures QA empaquetados: NO" -ForegroundColor Green
Write-Host "Modo upgrade: OFFLINE USB IN-PLACE" -ForegroundColor Green