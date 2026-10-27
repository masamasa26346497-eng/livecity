<#
Mission 45E: view the 24-ward LOCAL 3D Tiles produced by Mission 45D, read-only, on 127.0.0.1 only. ASCII only (Windows PowerShell 5.1).
Nothing is converted, copied, uploaded, committed or deleted. The 45D proof is re-computed from the files on disk before anything is served.
One command, from the repo root:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45e-preview.ps1
Default folders: output %LOCALAPPDATA%\LiveCity-3DTiles-Out-24 ; source ..\livecity-data-pipeline\public\map-data\osaka-city\buildings
-Plan only verifies and prints (serves nothing). Stop the server with Ctrl+C.
Note: the page loads CesiumJS from a CDN and base-map tiles from external servers; only the building data stays on this PC.
#>
param(
  [string]$LegacyBuildings = '..\livecity-data-pipeline\public\map-data\osaka-city\buildings',
  [string]$OutRoot = '',
  [string]$LayersRoot = '',
  [int]$Port = 8137,
  [switch]$Plan
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
function Resolve-AbsPath([string]$p) {
  if ([System.IO.Path]::IsPathRooted($p)) { return [System.IO.Path]::GetFullPath($p) }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $p))
}
$src = Resolve-AbsPath $LegacyBuildings
if ($OutRoot -eq '') {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set. Pass an absolute -OutRoot.' }
  $out = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'LiveCity-3DTiles-Out-24'))
} else { $out = Resolve-AbsPath $OutRoot }
if (-not (Test-Path -LiteralPath $src)) { throw 'Source folder not found. Pass -LegacyBuildings with an existing folder. (path not shown on purpose)' }
if (-not (Test-Path -LiteralPath $out)) { throw 'Output folder not found. Run tools\mission45d-convert-all.ps1 first. (path not shown on purpose)' }
$tool = Join-Path $repo 'tools\mission45e-preview.cjs'
$nodeArgs = @($tool, '--src', $src, '--out-root', $out, '--port', [string]$Port)
if ($LayersRoot -ne '') { $nodeArgs += @('--layers-root', (Resolve-AbsPath $LayersRoot)) }
if (-not $Plan) { $nodeArgs += '--serve' }
& node @nodeArgs
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host ('RESULT: NOT OK (exit ' + $code + '). Nothing was served. Source and output were not modified.'); exit $code }
exit 0
