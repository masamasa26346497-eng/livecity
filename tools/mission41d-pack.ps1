<#
Mission 41D/41E: offline pack dry-run / verify for the 41B manifest. Read-only. No upload, no copy, no delete.
ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI). Japanese folder names are
fine: the roots are handed to node through a UTF-8 (no BOM) JSON file, never through the command line.

ONE command from the repository root (newest plan is found automatically, roots default to the parent folder):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41d-pack.ps1 -PathContains fukushima

Defaults:
  -Manifest  newest %TEMP%\livecity-plan-*\manifest.json
  -Roots     ..   (the parent of the repo; the inventory root name, e.g. LiveCity, must equal that folder's own name)
Optional: -ListCategories   -OnlyCategory "3dtiles-output,building-tiles"   -Verify -PartsDir <dir>
Absolute and relative paths are both accepted (absolute TEMP paths are NOT joined to the current folder).
A filter that matches zero files prints the categories and exits non-zero: that is NOT a pass.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Manifest = '',
  [string]$Roots = '',
  [string]$OutDir = '',
  [string]$PathContains = '',
  [string]$OnlyCategory = '',
  [switch]$ListCategories,
  [switch]$Verify,
  [string]$PartsDir = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41d-pack.cjs'
if (-not (Test-Path $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$cwd = (Get-Location).Path

# Absolute paths must not be joined to the current folder (Join-Path 'C:\a' 'C:\b' -> 'C:\a\C:\b' -> GetFullPath throws).
function Resolve-Abs([string]$p) {
  $p = $p.Trim().Trim('"')
  if ([System.IO.Path]::IsPathRooted($p)) { return [System.IO.Path]::GetFullPath($p) }
  return [System.IO.Path]::GetFullPath((Join-Path $cwd $p))
}

$tmp = [System.IO.Path]::GetTempPath()
if ([string]::IsNullOrEmpty($Manifest)) {
  $dirs = Get-ChildItem -Path $tmp -Directory -Filter 'livecity-plan-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  foreach ($d in $dirs) {
    $cand = Join-Path $d.FullName 'manifest.json'
    if (Test-Path -LiteralPath $cand) { $Manifest = $cand; break }
  }
  if ([string]::IsNullOrEmpty($Manifest)) { throw 'no livecity-plan-*\manifest.json under TEMP. Run tools\mission41c-quick.ps1 first, or pass -Manifest.' }
  Write-Host ('Using the newest plan automatically: ' + (Split-Path -Leaf (Split-Path -Parent $Manifest)))
}
$Manifest = Resolve-Abs $Manifest
if (-not (Test-Path -LiteralPath $Manifest)) { throw 'manifest not found' }

if ($ListCategories) {
  & node $tool 'categories' '--manifest' $Manifest
  return
}

if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $tmp ('livecity-pack-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutDir = Resolve-Abs $OutDir
if ($Verify) {
  if ([string]::IsNullOrEmpty($PartsDir)) { throw '-Verify needs -PartsDir' }
  $PartsDir = Resolve-Abs $PartsDir
  & node $tool 'verify' '--manifest' $Manifest '--parts-dir' $PartsDir '--out' $OutDir
  if ($LASTEXITCODE -ne 0) { Write-Host ('verify reported a problem, exit code ' + $LASTEXITCODE) }
  Write-Host ('Details folder: ' + $OutDir)
  return
}
if ([string]::IsNullOrEmpty($Roots)) { $Roots = '..' }
$map = @{}
foreach ($piece in ($Roots -split ';')) {
  $t = $piece.Trim().Trim('"')
  if ($t.Length -eq 0) { continue }
  $p = Resolve-Abs $t
  if (-not (Test-Path -LiteralPath $p -PathType Container)) { throw ('root not found: ' + $p) }
  $leaf = Split-Path -Leaf $p
  if ([string]::IsNullOrEmpty($leaf)) { throw ('root has no folder name (drive root?): ' + $p) }
  $map[$leaf] = $p
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
if ($code -eq 3) { Write-Host 'The filter matched zero files. See the category list above; retry with -OnlyCategory <name>.' }
elseif ($code -ne 0) { Write-Host ('dry-run reported a problem, exit code ' + $code) }
Write-Host ('Details folder: ' + $OutDir)
Write-Host 'Paste only the text printed above. The details folder uses anonymous ids, but do not paste file paths.'
