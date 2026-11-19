<#
Mission 46A: one-command READ-ONLY alignment audit for all 24 wards on this PC. ASCII only (Windows PowerShell 5.1).
Nothing is changed, moved, converted, uploaded or deleted. Inputs are only read. No network.
The report holds counts, percentages and metres only (no building id, no coordinate, no path).

Minimum (source footprints + source roads only):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission46a-align-audit.ps1 -Src "..\livecity-data-pipeline\public\map-data\osaka-city"
Full (also checks 45D tiles and 45I layers):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission46a-align-audit.ps1 -Src "..." -TilesRoot "%LOCALAPPDATA%\LiveCity-3DTiles-Out-24" -LayersRoot "<45I root>"
Optional: -Wards fukushima,kita   -Out "C:\somewhere\new\report.json" (must not exist, must be outside the inputs)   -Serve (aggregate JSON only, 127.0.0.1)
"no-inconsistency-found" is NOT "aligned". See the LIMITS lines printed at the end.
#>
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [string]$TilesRoot = '',
  [string]$LayersRoot = '',
  [string]$Wards = '',
  [string]$Out = '',
  [switch]$Serve
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$argsList = @((Join-Path $repo 'tools\mission46a-align-audit.cjs'), '--src', $Src)
if ($TilesRoot -ne '') { $argsList += @('--tiles-root', $TilesRoot) }
if ($LayersRoot -ne '') { $argsList += @('--layers-root', $LayersRoot) }
if ($Wards -ne '') { $argsList += @('--wards', $Wards) }
if ($Out -ne '') { $argsList += @('--out', $Out) }
if ($Serve) { $argsList += '--serve' }
& node @argsList
$code = $LASTEXITCODE
if ($code -eq 2) { Write-Host 'Bad arguments or unsafe --out. Nothing was done.' }
elseif ($code -eq 1) { Write-Host 'Exit 1: at least one ward has issues (or an error). Read the ward lines above; nothing was changed.' }
exit $code
