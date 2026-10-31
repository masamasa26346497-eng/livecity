<#
Mission 40C: validate legacy Live City building tiles read-only (no copy) and batch-convert them to 3D Tiles.
NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI,
which garbles non-ASCII text and causes ParserError. Keep it ASCII.
  - The source (-LegacyBuildings) is never modified, deleted or copied; Node only reads it.
  - The output (-OutRoot) must be empty or missing; nothing is overwritten or deleted.
Usage (from the repository root):
  powershell -ExecutionPolicy Bypass -File tools\mission40c-run-local.ps1 -LegacyBuildings "C:\path\to\buildings"
  Validate only: add -Mode validate   (modes: all | validate | inventory | convert; default all)
#>
param(
  [Parameter(Mandatory = $true)][string]$LegacyBuildings,
  [string]$OutRoot = '',
  [string]$Wards = '',
  [switch]$OnlyOk,
  [ValidateSet('all', 'validate', 'inventory', 'convert', 'diagnose')][string]$Mode = 'all'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrEmpty($OutRoot)) { $OutRoot = Join-Path (Split-Path -Parent $repo) 'livecity-3dtiles-out' }
$tool = Join-Path $repo 'tools\mission40b-legacy-tiles-batch.cjs'
if (-not (Test-Path $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$LegacyBuildings = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LegacyBuildings))
if (-not (Test-Path (Join-Path $LegacyBuildings 'manifest.json'))) { throw ('manifest.json not found in ' + $LegacyBuildings + ' (point to the buildings folder)') }
Write-Host 'Tile counts are scoped by Node: the 24 ward folders vs other folders (osm-fallback, unclassified) are reported separately.'

if ($Mode -eq 'all' -or $Mode -eq 'validate') {
  & node $tool --src $LegacyBuildings --validate
  $validateExit = $LASTEXITCODE
  if ($validateExit -ne 0) {
    Write-Warning 'Some wards failed validation. See data\reports\mission40b-legacy-reuse\validate-external.json. Use -Mode convert to convert anyway.'
  }
  if ($Mode -eq 'all' -and $validateExit -ne 0) { throw 'Validation failed; conversion aborted (use -Mode convert to force).' }
}
if ($Mode -eq 'diagnose') {
  & node $tool --src $LegacyBuildings --diagnose
  if ($LASTEXITCODE -ne 0) { throw ('diagnose failed, exit code ' + $LASTEXITCODE) }
  Write-Host 'Report: data\reports\mission40b-legacy-reuse\diagnose-external.json (read-only; source untouched).'
}
if ($Mode -eq 'all' -or $Mode -eq 'inventory') {
  & node $tool --src $LegacyBuildings --inventory
  if ($LASTEXITCODE -ne 0) { throw ('inventory failed, exit code ' + $LASTEXITCODE) }
}
if ($Mode -eq 'all' -or $Mode -eq 'convert') {
  $OutRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutRoot))
  if ((Test-Path $OutRoot) -and (Get-ChildItem $OutRoot -Force | Select-Object -First 1)) { throw ('Output dir is not empty (will not overwrite): ' + $OutRoot) }
  New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null
  $nodeArgs = @($tool, '--src', $LegacyBuildings, '--all-available', '--out-root', $OutRoot)
  if (-not [string]::IsNullOrEmpty($Wards)) { $nodeArgs += @('--wards', $Wards) }
  if ($OnlyOk) { $nodeArgs += '--only-ok' }
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw ('convert failed, exit code ' + $LASTEXITCODE) }
  $sum = (Get-ChildItem $OutRoot -Recurse -File | Measure-Object Length -Sum).Sum
  if ($null -eq $sum) { $sum = 0 }
  $gb = [math]::Round($sum / 1GB, 2)
  Write-Host ('Conversion done: ' + $OutRoot + ' (' + $gb + ' GB). Do NOT git add this folder.')
}
