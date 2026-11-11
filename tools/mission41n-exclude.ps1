<#
Mission 41N: ONE command to hold a file back from the transfer candidates. Offline, read-only, no upload, no network.
ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI). NOT run on real data yet (synthetic fixtures only).

From the repository root (dry-run; prints anonymous counts only, writes nothing):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41n-exclude.ps1
Also check your existing 41F tar files for the held id (headers only, tars are never modified or deleted):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41n-exclude.ps1 -TarDir "D:\path\to\41f-out"
Write a NEW exclusion plan (ids only) into a NEW folder, to pass later as: mission41f-pack-local.cjs create ... --exclude-plan <file>
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41n-exclude.ps1 -WritePlanDir "..\livecity-exclusion-plan"
Sanitize PLAN (read-only; in-memory check, writes nothing; needs the same roots as 41L):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41n-exclude.ps1 -Mode SanitizePlan -Roots ".."

Nothing is changed, moved, deleted or sent. No gate is opened. Paste only the printed text (no paths, no values).
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [ValidateSet('DryRun', 'SanitizePlan')][string]$Mode = 'DryRun',
  [string]$Id = 'e6b68bd7',
  [string]$Plan = '',
  [string]$Roots = '..',
  [string]$TarDir = '',
  [string]$WritePlanDir = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41n-exclude.cjs'
if (-not (Test-Path -LiteralPath $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
if ($Id -notmatch '^[0-9a-f]{8}(,[0-9a-f]{8})*$') { throw '-Id must be one or more 8-character hex ids (comma separated)' }
$cwd = (Get-Location).Path
function Resolve-Abs([string]$p) {
  $p = $p.Trim().Trim('"')
  if ([System.IO.Path]::IsPathRooted($p)) { return [System.IO.Path]::GetFullPath($p) }
  return [System.IO.Path]::GetFullPath((Join-Path $cwd $p))
}
$tmp = [System.IO.Path]::GetTempPath()
$planDir = ''
if ([string]::IsNullOrEmpty($Plan)) {
  $dirs = Get-ChildItem -Path $tmp -Directory -Filter 'livecity-plan-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  foreach ($d in $dirs) { if (Test-Path -LiteralPath (Join-Path $d.FullName 'manifest.json')) { $planDir = $d.FullName; break } }
  if ([string]::IsNullOrEmpty($planDir)) { throw 'no livecity-plan-*\manifest.json under TEMP. Pass -Plan <folder>.' }
} else { $planDir = Resolve-Abs $Plan }
$manifest = Join-Path $planDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw 'manifest not found in the plan folder' }
Write-Host ('Using plan: ' + (Split-Path -Leaf $planDir))

if ($Mode -eq 'DryRun') {
  $nodeArgs = @($tool, 'dry-run', '--manifest', $manifest, '--id', $Id)
  if (-not [string]::IsNullOrEmpty($TarDir)) {
    $t = Resolve-Abs $TarDir
    if (-not (Test-Path -LiteralPath $t -PathType Container)) { throw 'tar folder not found' }
    $nodeArgs += @('--tar-dir', $t)
  }
  if (-not [string]::IsNullOrEmpty($WritePlanDir)) { $nodeArgs += @('--write-plan', (Resolve-Abs $WritePlanDir)) }
  & node @nodeArgs
  $code = $LASTEXITCODE
  if ($code -ne 0 -and $code -ne 2) { throw ('dry-run failed, exit ' + $code) }
  if ($code -eq 2) { Write-Host 'WARNING: an id is not in this manifest.' }
  Write-Host 'Dry-run only. The original file was not touched. All gates stay false.'
  exit 0
}

$map = @{}
foreach ($piece in ($Roots -split ';')) {
  $r = $piece.Trim().Trim('"')
  if ($r.Length -eq 0) { continue }
  $p = Resolve-Abs $r
  if (-not (Test-Path -LiteralPath $p -PathType Container)) { throw ('root not found: ' + $p) }
  $leaf = Split-Path -Leaf $p
  if ([string]::IsNullOrEmpty($leaf)) { throw ('root has no folder name (drive root?): ' + $p) }
  $map[$leaf] = $p
}
if ($map.Count -eq 0) { throw 'no roots given' }
$rootsFile = Join-Path $tmp ('livecity-roots41n-' + [guid]::NewGuid().ToString('N') + '.json')
[System.IO.File]::WriteAllText($rootsFile, ($map | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
& node $tool 'sanitize-plan' '--manifest' $manifest '--roots-file' $rootsFile '--id' $Id
if ($LASTEXITCODE -ne 0) { throw ('sanitize-plan failed, exit ' + $LASTEXITCODE) }
Write-Host 'Plan only: nothing was written. A derived copy needs your explicit approval in a later step.'
exit 0
