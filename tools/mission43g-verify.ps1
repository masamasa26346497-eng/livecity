<#
Mission 43G: READ-ONLY verification of a 43F output folder. ASCII only (Windows PowerShell 5.1).
Writes nothing, uploads nothing, deletes nothing. Output has ward ids, counts and reason kinds only (no paths, no ids).
Usage (repo root):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission43g-verify.ps1 -OutRoot "..\livecity-3dtiles-out" -LegacyBuildings "..\livecity-data-pipeline\public\map-data\osaka-city\buildings"
-LegacyBuildings is optional; when given, the output is also compared with the audited source (read-only).
#>
param(
  [string]$OutRoot = '..\livecity-3dtiles-out',
  [string]$LegacyBuildings = '',
  [string]$Wards = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$out = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutRoot))
if (-not (Test-Path -LiteralPath $out)) { throw 'OutRoot folder not found (pass -OutRoot)' }
$tool = Join-Path $repo 'tools\mission43g-verify-local.cjs'
$nodeArgs = @($tool, '--out-root', $out)
if ($LegacyBuildings -ne '') {
  $src = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LegacyBuildings))
  if (-not (Test-Path -LiteralPath $src)) { throw 'LegacyBuildings folder not found' }
  $nodeArgs += @('--src', $src)
}
if ($Wards -ne '') { $nodeArgs += @('--wards', $Wards) }
# Out-Host keeps node stdout out of the pipeline so it cannot be mixed with $LASTEXITCODE handling.
& node @nodeArgs | Out-Host
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host ('RESULT: NOT READY (exit ' + $code + '). Nothing was changed. Paste the JSON above (no paths or ids).'); exit $code }
Write-Host 'RESULT: verified. This is not a licence, privacy or publication approval; uploadAllowed stays 0.'
exit 0
