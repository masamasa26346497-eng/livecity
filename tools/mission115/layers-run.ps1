# Mission 115 one-shot for Windows PowerShell 5.1 (ASCII only). Audits, builds road/water layers for 3 wards into a private folder, verifies.
# Usage (repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission115\layers-run.ps1 -Src "..\livecity-data-pipeline\public\map-data\osaka-city"
param([Parameter(Mandatory=$true)][string]$Src, [string]$LayersRoot = '', [string]$Wards = 'nishi,fukushima,yodogawa', [switch]$AuditOnly)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$srcAbs = (Resolve-Path -LiteralPath $Src).Path
if ($LayersRoot -eq '') { $LayersRoot = Join-Path $env:LOCALAPPDATA 'LiveCity-MapLayers-Out-24' }
Push-Location $repo
try {
  & node tools\mission115\layers-run.cjs audit --src $srcAbs --wards $Wards
  if ($LASTEXITCODE -ne 0) { throw 'audit failed' }
  if ($AuditOnly) { return }
  & node tools\mission115\layers-run.cjs build --src $srcAbs --layers-root $LayersRoot --wards $Wards
  if ($LASTEXITCODE -ne 0) { throw ('build or verify failed, exit code ' + $LASTEXITCODE + '; not serving') }
  Write-Host 'Next: serve with the existing preview (2025 building root untouched):'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45e-preview.ps1 -LayersRoot "<same LayersRoot>"'
  Write-Host 'URL: http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?ext45=1  (check stats.vec45i and compare roads with buildings)'
} finally { Pop-Location }
