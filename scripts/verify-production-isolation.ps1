param(
    [switch]$Packaged
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot


function Assert-NoForbiddenFiles {
    param(
        [Parameter(Mandatory)]
        [string]$Root,

        [Parameter(Mandatory)]
        [string]$Label,

        [switch]$CheckExcel
    )

    if (-not (Test-Path $Root)) {
        Write-Host "${Label}: no existe, omitido." -ForegroundColor DarkGray
        return
    }

    $violations = @(
        Get-ChildItem `
            -Path $Root `
            -Recurse `
            -File `
            -ErrorAction SilentlyContinue |
        Where-Object {

            $name = $_.Name.ToLowerInvariant()
            $ext  = $_.Extension.ToLowerInvariant()

            $name.EndsWith(".db") -or
            $name.EndsWith(".sqlite") -or
            $name.EndsWith(".sqlite3") -or
            $name.EndsWith(".db-wal") -or
            $name.EndsWith(".db-shm") -or
            (
                $CheckExcel -and
                $ext -in @(".xls", ".xlsx", ".xlsm")
            )
        }
    )

    if ($violations.Count -gt 0) {

        Write-Host ""
        Write-Host "DATOS PROHIBIDOS DETECTADOS EN ${Label}" `
            -ForegroundColor Red

        $violations |
            Select-Object FullName, Length |
            Format-Table -AutoSize

        throw "Gate de aislamiento QA fallido."
    }

    Write-Host "${Label}: OK" -ForegroundColor Green
}


function Get-AsarCli {

    $pnpmRoot = Join-Path $projectRoot "node_modules\.pnpm"

    if (-not (Test-Path $pnpmRoot)) {
        throw "No existe node_modules\.pnpm. Ejecuta pnpm install."
    }

    $asarCli = Get-ChildItem `
        -Path $pnpmRoot `
        -Directory `
        -Filter "@electron+asar@*" `
        -ErrorAction SilentlyContinue |
    ForEach-Object {
        Join-Path `
            $_.FullName `
            "node_modules\@electron\asar\bin\asar.js"
    } |
    Where-Object {
        Test-Path $_
    } |
    Select-Object -First 1

    if (-not $asarCli) {
        throw "No se encontro CLI local de @electron/asar."
    }

    return $asarCli
}


function Assert-AsarClean {
    param(
        [Parameter(Mandatory)]
        [string]$AsarPath
    )

    if (-not (Test-Path $AsarPath)) {
        throw "No existe app.asar: $AsarPath"
    }

    $asarCli = Get-AsarCli

    $asarList = @(
        & node $asarCli list $AsarPath
    )

    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo inspeccionar app.asar."
    }

    $forbidden = @(
        $asarList |
        Where-Object {
            $_ -match '(?i)\.(db|sqlite|sqlite3|db-wal|db-shm)$' -or
            $_ -match '(?i)\.(xls|xlsx|xlsm)$' -or
            $_ -match '(?i)(^|[\\/])(tests|fixtures|__fixtures__)([\\/]|$)' -or
            $_ -match '(?i)cartera-dashboard-test-data'
        }
    )

    if ($forbidden.Count -gt 0) {

        Write-Host ""
        Write-Host "CONTENIDO PROHIBIDO EN APP.ASAR:" `
            -ForegroundColor Red

        $forbidden |
            ForEach-Object {
                Write-Host "  $_" -ForegroundColor Red
            }

        throw "app.asar contiene datos o artefactos QA."
    }

    Write-Host "app.asar sin DB/Excel/tests/fixtures QA: OK" `
        -ForegroundColor Green
}


Write-Host ""
Write-Host "=== AISLAMIENTO QA / PRODUCCION ===" `
    -ForegroundColor Cyan


# ============================================================
# ARCHIVOS FISICOS EN CODIGO / BUILD
# ============================================================

foreach ($folder in @(
    "src",
    "electron",
    "public",
    "build",
    "dist",
    "dist-electron"
)) {

    Assert-NoForbiddenFiles `
        -Root (Join-Path $projectRoot $folder) `
        -Label $folder `
        -CheckExcel
}


# ============================================================
# REFERENCIAS QA GENERALES
# electron/db.ts se controla mediante contrato especifico
# ============================================================

$productFiles = @()

foreach ($folder in @("src", "electron")) {

    $path = Join-Path $projectRoot $folder

    if (-not (Test-Path $path)) {
        continue
    }

    $productFiles += @(
        Get-ChildItem `
            -Path $path `
            -Recurse `
            -File `
            -Include *.ts,*.tsx,*.js,*.jsx `
            -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FullName -ne (Join-Path $projectRoot "electron\db.ts")
        }
    )
}

$qaReferences = @(
    $productFiles |
    Select-String `
        -Pattern "cartera-dashboard-test-data|C:\\Users\\.*\\Downloads\\.*\.(xls|xlsx)" `
        -ErrorAction SilentlyContinue
)

if ($qaReferences.Count -gt 0) {

    Write-Host ""
    Write-Host "REFERENCIAS QA NO AUTORIZADAS:" `
        -ForegroundColor Red

    $qaReferences |
        Select-Object Path, LineNumber, Line |
        Format-Table -Wrap -AutoSize

    throw "Existe una referencia QA no autorizada en codigo productivo."
}

Write-Host "Referencias QA generales: OK" `
    -ForegroundColor Green


# ============================================================
# CONTRATO DB DESARROLLO / PRODUCCION
# ============================================================

$dbFile = Join-Path $projectRoot "electron\db.ts"
$dbText = [System.IO.File]::ReadAllText($dbFile)

$qaOccurrences = [regex]::Matches(
    $dbText,
    '"tests"\s*,\s*"data"\s*,\s*"cartera\.db"'
).Count

if ($qaOccurrences -ne 1) {
    throw "electron/db.ts debe contener exactamente 1 referencia a la base QA. Encontradas: $qaOccurrences"
}

$devPattern = '(?s)function resolveDevelopmentDbPath\(\): string \{.*?"tests",\s*"data",\s*"cartera\.db".*?\r?\n\s*\)'

if ($dbText -notmatch $devPattern) {
    throw "Ruta QA no encapsulada en resolveDevelopmentDbPath()."
}

$prodPattern = '(?s)function resolveProductionDbPath\(\): string \{.*?app\.getPath\("userData"\).*?"data".*?"cartera\.db".*?\r?\n\}'

if ($dbText -notmatch $prodPattern) {
    throw "resolveProductionDbPath() no apunta a userData/data/cartera.db."
}

$resolverPattern = '(?s)function resolveDbFilePath\(\): string \{\s*if \(app\.isPackaged\) \{\s*return resolveProductionDbPath\(\);\s*\}\s*return resolveDevelopmentDbPath\(\);\s*\}'

if ($dbText -notmatch $resolverPattern) {
    throw "resolveDbFilePath() no garantiza separacion DEV/PROD."
}

$getPathPattern = '(?s)export function getDbFilePath\(\): string \{\s*return resolveDbFilePath\(\);\s*\}'

if ($dbText -notmatch $getPathPattern) {
    throw "getDbFilePath() contiene fallback no autorizado."
}

Write-Host "Contrato DB DEV/PROD: OK" `
    -ForegroundColor Green


# ============================================================
# PAQUETE WINDOWS
# ============================================================

if ($Packaged) {

    $resources = Join-Path `
        $projectRoot `
        "release\win-unpacked\resources"

    if (-not (Test-Path $resources)) {
        throw "No existe paquete Windows: $resources"
    }

    Assert-NoForbiddenFiles `
        -Root $resources `
        -Label "release/win-unpacked/resources" `
        -CheckExcel

    $qaDirectories = @(
        Get-ChildItem `
            -Path $resources `
            -Recurse `
            -Directory `
            -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -in @(
                "tests",
                "fixtures",
                "__fixtures__"
            )
        }
    )

    if ($qaDirectories.Count -gt 0) {

        $qaDirectories |
            Select-Object FullName |
            Format-Table -AutoSize

        throw "Se encontraron directorios QA dentro de resources."
    }

    Write-Host "Directorios QA empaquetados: OK" `
        -ForegroundColor Green

    $asarPath = Join-Path $resources "app.asar"

    Assert-AsarClean `
        -AsarPath $asarPath
}


Write-Host ""
Write-Host "AISLAMIENTO QA / PRODUCCION: OK" `
    -ForegroundColor Green