<#
Mission 41D: offline pack dry-run / verify for the 41B manifest. Read-only. No upload, no copy, no delete.
ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI). Japanese folder names are
fine: the roots are handed to node through a UTF-8 (no BOM) JSON file, never through the command line.

From the repository root:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41d-pack.ps1 -Manifest "<plan dir>\manifest.json" -Roots "..\livecity-data-pipeline;..\livecity-3dtiles-out-fukushima"
Optional: -PathContains fukushima   -OnlyCategory "3dtiles-output,building-tiles"   -Verify -PartsDir <dir>
Root folder names must equal the root names in the 41A inventory (the folder's own name).
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [string]$Roots = '',
  [string]$OutDir = '',
  [string]$PathContains = '',
  [string]$OnlyCategory = '',
  [switch]$Verify,
  [string]$PartsDir = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41d-pack.cjs'
if (-not (Test-Path $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$cwd = (Get-Location).Path
$Manifest = [System.IO.Path]::GetFullPath((Join-Path $cwd $Manifest))
if (-not (Test-Path -LiteralPath $Manifest)) { throw 'manifest not found' }
$tmp = [System.IO.Path]::GetTempPath()
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $tmp ('livecity-pack-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutDir = [System.IO.Path]::GetFullPath((Join-Path $cwd $OutDir))
if ($Verify) {
  if ([string]::IsNullOrEmpty($PartsDir)) { throw '-Verify needs -PartsDir' }
  $PartsDir = [System.IO.Path]::GetFullPath((Join-Path $cwd $PartsDir))
  & node $tool 'verify' '--manifest' $Manifest '--parts-dir' $PartsDir '--out' $OutDir
  if ($LASTEXITCODE -ne 0) { Write-Host ('verify reported a problem, exit code ' + $LASTEXITCODE) }
  Write-Host ('Details folder: ' + $OutDir)
  return
}
if ([string]::IsNullOrEmpty($Roots)) { throw '-Roots is required for the dry-run' }
$map = @{}
foreach ($piece in ($Roots -split ';')) {
  $t = $piece.Trim().Trim('"')
  if ($t.Length -eq 0) { continue }
  $p = [System.IO.Path]::GetFullPath((Join-Path $cwd $t))
  if (-not (Test-Path -LiteralPath $p -PathType Container)) { throw ('root not found: ' + $p) }
  $map[(Split-Path -Leaf $p)] = $p
}
if ($map.Count -eq 0) { throw 'no roots given' }
$rootsFile = Join-Path $tmp ('livecity-roots-' + [guid]::NewGuid().ToString('N') + '.json')
$json = $map | ConvertTo-Json
[System.IO.File]::WriteAllText($rootsFile, $json, (New-Object System.Text.UTF8Encoding($false)))
$nodeArgs = @($tool, 'pack', '--manifest', $Manifest, '--roots-file', $rootsFile, '--out', $OutDir, '--dry-run')
if (-not [string]::IsNullOrEmpty($PathContains)) { $nodeArgs += @('--path-contains', $PathContains) }
if (-not [string]::IsNullOrEmpty($OnlyCategory)) { $nodeArgs += @('--only-category', $OnlyCategory) }
Write-Host 'Dry-run only. Reading file sizes (read-only). Nothing is copied, uploaded or deleted.'
& node @nodeArgs
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host ('dry-run reported a problem, exit code ' + $code) }
Write-Host ('Details folder: ' + $OutDir)
Write-Host 'Paste only the text printed above. The details folder uses anonymous ids, but do not paste file paths.'
