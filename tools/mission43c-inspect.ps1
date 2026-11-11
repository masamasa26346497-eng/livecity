<#
Mission 43C: anonymous read-only inspection of the owner's legacy buildings folder.
ASCII only (Windows PowerShell 5.1). Nothing is copied, written, packed, deleted or uploaded.
Output: counts only (no file names, paths or values). eligible/uploadAllowed are always 0.
Usage (repo root):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission43c-inspect.ps1 -LegacyBuildings "..\livecity-data-pipeline\public\map-data\osaka-city\buildings"
#>
param(
  [Parameter(Mandatory = $true)][string]$LegacyBuildings
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$src = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LegacyBuildings))
if (-not (Test-Path $src)) { throw 'LegacyBuildings folder not found' }
$tool = Join-Path $repo 'tools\mission43-ward-rebuild.cjs'
Write-Host 'inspect (read-only, anonymous counts) ...'
& node $tool inspect --src $src
$codeInspect = $LASTEXITCODE
Write-Host 'preflight (per-ward file/byte counts) ...'
& node $tool preflight --src $src
$codePre = $LASTEXITCODE
if ($codeInspect -ne 0 -or $codePre -ne 0) { Write-Host ('RESULT: NOT READY (inspect exit ' + $codeInspect + ', preflight exit ' + $codePre + '). Nothing was changed.'); exit 1 }
Write-Host 'RESULT: inspect ok. This is not a licence or privacy approval; uploadAllowed stays 0.'
