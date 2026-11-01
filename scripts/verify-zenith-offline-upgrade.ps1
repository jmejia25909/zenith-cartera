$ErrorActionPreference = "Stop"
$root = "C:\Proyectos\Zenith-Cartera"

$db = Get-Content "$root\electron\db.ts" -Raw -Encoding UTF8
$main = Get-Content "$root\electron\main.ts" -Raw -Encoding UTF8
$builder = Get-Content "$root\electron-builder.json5" -Raw -Encoding UTF8
$index = Get-Content "$root\index.html" -Raw -Encoding UTF8
$release = Get-Content "$root\electron\releaseUpgrade.ts" -Raw -Encoding UTF8
$pkg = Get-Content "$root\package.json" -Raw -Encoding UTF8 | ConvertFrom-Json

function Test-Regex {
  param(
    [string]$Text,
    [string]$Pattern
  )

  return [regex]::IsMatch(
    $Text,
    $Pattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
  )
}

$checks = [ordered]@{
  "package.name preservado" = ($pkg.name -eq "cartera-dashboard")
  "version 1.2.0" = ($pkg.version -eq "1.2.0")
  "appId preservado" = $builder.Contains('appId: "com.mm.carteradashboard"')
  "productName Zenith" = $builder.Contains('productName: "Zenith Cartera"')
  "artifactName Zenith" = $builder.Contains('artifactName: "Zenith Cartera Setup ${version}.${ext}"')
  "userData histórico fijado" = Test-Regex $main 'app\.setPath\s*\(\s*"userData"\s*,\s*join\s*\(\s*app\.getPath\s*\(\s*"appData"\s*\)\s*,\s*"cartera-dashboard"\s*\)\s*,?\s*\)'
  "app.setName Zenith" = Test-Regex $main 'app\.setName\s*\(\s*"Zenith Cartera"\s*\)'
  "BrowserWindow icon fallback" = Test-Regex $main 'join\s*\(\s*process\.resourcesPath\s*,\s*"icon\.ico"\s*\)'
  "HTML Zenith" = $index.Contains("<title>Zenith Cartera</title>")
  "NSIS preserva AppData" = $builder.Contains("deleteAppDataOnUninstall: false")
  "win.icon configurado" = $builder.Contains('icon: "build/icon.ico"')
  "installerIcon configurado" = $builder.Contains('installerIcon: "build/icon.ico"')
  "upgrade coordinado" = Test-Regex $db 'await\s+beginReleaseUpgrade\s*\('
  "safety legado preservado" = Test-Regex $db 'await\s+initializeDataSafety\s*\('
  "schema validado" = Test-Regex $db 'validateReleaseSchema\s*\(\s*db\s*\)'
  "release registrada" = Test-Regex $db 'completeReleaseUpgrade\s*\(\s*db\s*,\s*releaseUpgrade\s*,?\s*\)'
  "restore automático" = Test-Regex $db 'restoreDatabaseFile\s*\(\s*dbPath\s*,\s*restoreFrom\s*,?\s*\)'
  "backup por versión" = Test-Regex $release 'function\s+createReleaseBackup\s*\('
}

$failed = @()

foreach ($item in $checks.GetEnumerator()) {
  $status = if ($item.Value) { "OK" } else { "FAIL" }
  Write-Host ("{0,-40} {1}" -f $item.Key, $status)

  if (-not $item.Value) {
    $failed += $item.Key
  }
}

$updaterMatches = @(
  Get-ChildItem "$root\electron","$root\src" -Recurse -File |
    Where-Object { $_.Extension -in ".ts",".tsx",".js" } |
    Select-String -Pattern '\bautoUpdater\b|electron-updater'
)

$hasOnlineUpdater = $updaterMatches.Count -gt 0

Write-Host (
  "{0,-40} {1}" -f `
    "sin updater online",
    $(if (-not $hasOnlineUpdater) { "OK" } else { "FAIL" })
)

if ($hasOnlineUpdater) {
  $failed += "sin updater online"

  Write-Host "`nReferencias encontradas:" -ForegroundColor Yellow

  $updaterMatches |
    Select-Object Path, LineNumber, Line |
    Format-Table -AutoSize
}

if ($failed.Count -gt 0) {
  throw "Verificación fallida: $($failed -join ', ')"
}

if (-not (Test-Path "$root\build\icon.ico")) {
  Write-Warning "Pendiente branding: falta build\icon.ico."
}

Write-Host "`nCONTRATO ZENITH OFFLINE IN-PLACE: OK" -ForegroundColor Green
