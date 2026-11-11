<#
Mission 41F: LOCAL tar packaging of the Fukushima subset from the 41B manifest. Offline. No upload, no network.
ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI). Japanese folder names are fine:
roots go to node through a UTF-8 (no BOM) JSON file.

NOT run on real data yet. The owner PC has not run this script.

ONE command from the repository root (newest %TEMP%\livecity-plan-*\manifest.json is found automatically):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41f-pack-local.ps1

Defaults: -PathContains fukushima, -Roots .. (the parent folder; its own name must equal the manifest root, e.g. LiveCity),
          -OutDir %TEMP%\livecity-pack41f-<time> (must be OUTSIDE the data roots; must be new or a previous 41F folder).
Never packed: categories secrets-candidate and backup-archive; file names that look like keys/tokens (a hint, NOT a secret scan).
Nothing is overwritten or deleted. A failed partial archive is moved to <OutDir>\quarantine.
Packing is NOT permission to transfer: licence / secrets / personal-data gates stay closed.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Manifest = '',
  [string]$Roots = '',
  [string]$OutDir = '',
  [string]$PathContains = 'fukushima',
  [string]$OnlyCategory = '',
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41f-pack-local.cjs'
if (-not (Test-Path -LiteralPath $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$cwd = (Get-Location).Path
if ($VerifyOnly) {
  if ([string]::IsNullOrEmpty($OutDir)) { throw '-VerifyOnly needs -OutDir (the 41F output folder)' }
  $vo = $OutDir.Trim().Trim('"')
  if (-not [System.IO.Path]::IsPathRooted($vo)) { $vo = Join-Path $cwd $vo }
  & node $tool 'verify' '--out' ([System.IO.Path]::GetFullPath($vo))
  exit $LASTEXITCODE
}
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
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $tmp ('livecity-pack41f-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutDir = Resolve-Abs $OutDir
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
$rootsFile = Join-Path $tmp ('livecity-roots41f-' + [guid]::NewGuid().ToString('N') + '.json')
$json = $map | ConvertTo-Json
[System.IO.File]::WriteAllText($rootsFile, $json, (New-Object System.Text.UTF8Encoding($false)))
$nodeArgs = @($tool, 'create', '--manifest', $Manifest, '--roots-file', $rootsFile, '--out', $OutDir)
if (-not [string]::IsNullOrEmpty($PathContains)) { $nodeArgs += @('--path-contains', $PathContains) }
if (-not [string]::IsNullOrEmpty($OnlyCategory)) { $nodeArgs += @('--only-category', $OnlyCategory) }
Write-Host 'Local packaging only. Source files are only read. Nothing is uploaded, overwritten or deleted.'
& node @nodeArgs
$code = $LASTEXITCODE
if ($code -eq 0) {
  Write-Host ''
  & node $tool 'verify' '--out' $OutDir
  $code = $LASTEXITCODE
}
if ($code -eq 3) { Write-Host 'The filter matched zero packable files (see 41D -ListCategories).' }
elseif ($code -ne 0) { Write-Host ('packaging reported a problem, exit code ' + $code + '. Partial files, if any, are in the quarantine folder.') }
Write-Host ('Output folder: ' + $OutDir)
Write-Host 'Paste only the text printed above, no file paths.'
exit $code
