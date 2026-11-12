<#
Mission 43F: offline conversion of the PC-only wards to local 3D Tiles. ASCII only (Windows PowerShell 5.1).
DEFAULT IS A DRY-RUN: nothing is created or converted unless -Execute is given.
Input is read-only. Output must be a NEW (or empty) folder outside the repository and outside the source folder.
Nothing is uploaded, committed, published or deleted. Output has counts and issue kinds only (no paths, no ids).
Usage (repo root):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission43f-convert.ps1 -LegacyBuildings "..\livecity-data-pipeline\public\map-data\osaka-city\buildings" -OutRoot "..\livecity-3dtiles-out"
#>
param(
  [string]$LegacyBuildings = '..\livecity-data-pipeline\public\map-data\osaka-city\buildings',
  [string]$OutRoot = '..\livecity-3dtiles-out',
  [string]$Wards = '',
  [int]$Next = 1,
  [switch]$Calibrate,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$src = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LegacyBuildings))
$out = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutRoot))
if (-not (Test-Path -LiteralPath $src)) { throw 'LegacyBuildings folder not found (pass -LegacyBuildings)' }
$tool = Join-Path $repo 'tools\mission43f-pc-convert.cjs'
$nodeArgs = @($tool, '--src', $src, '--out-root', $out)
if ($Wards -ne '') { $nodeArgs += @('--wards', $Wards) } else { $nodeArgs += @('--next', [string]$Next) }
if ($Calibrate) { $nodeArgs += '--calibrate' }
if ($Execute) { $nodeArgs += '--execute'; Write-Host 'EXECUTE mode: converting into a local folder only (no upload).' } else { Write-Host 'DRY-RUN (default): nothing will be created. Add -Execute to convert.' }
# Out-Host keeps node stdout out of the pipeline so it cannot be mixed with $LASTEXITCODE handling.
& node @nodeArgs | Out-Host
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host ('RESULT: NOT OK (exit ' + $code + '). Source data was not modified. Paste the JSON above (no paths or ids).'); exit $code }
Write-Host 'RESULT: ok. This is not a licence, privacy or publication approval; uploadAllowed stays 0.'
exit 0
