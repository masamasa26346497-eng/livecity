<#
Mission 43E: one-command, read-only, anonymous audit of the owner's legacy buildings folder, chained into the batch plan.
ASCII only (Windows PowerShell 5.1). Nothing is copied, written, converted, deleted or uploaded.
Output: counts and issue kinds only (no paths, no building ids). uploadAllowed is always 0.
Usage (repo root; default folder is the known relative location):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission43e-audit.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission43e-audit.ps1 -LegacyBuildings "..\livecity-data-pipeline\public\map-data\osaka-city\buildings"
#>
param(
  [string]$LegacyBuildings = '..\livecity-data-pipeline\public\map-data\osaka-city\buildings'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$src = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LegacyBuildings))
if (-not (Test-Path -LiteralPath $src)) { throw 'LegacyBuildings folder not found (pass -LegacyBuildings)' }
$tool = Join-Path $repo 'tools\mission43d-ward-batch.cjs'
Write-Host 'audit + batch-plan (read-only, anonymous) ...'
# Out-Host keeps node stdout out of the pipeline so it cannot be mixed with $LASTEXITCODE handling.
& node $tool audit-plan --src $src | Out-Host
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host ('RESULT: NOT READY (exit ' + $code + '). Nothing was changed. Paste the JSON above (it has no paths or ids).'); exit 1 }
Write-Host 'RESULT: audit ready. This is not a licence or privacy approval; uploadAllowed stays 0.'
exit 0
