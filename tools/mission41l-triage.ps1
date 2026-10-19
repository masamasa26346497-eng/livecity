<#
Mission 41L: ONE command to triage the 41K content-scan result. Offline, read-only, no upload, no network.
ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI). NOT run on real data yet (synthetic fixtures only).

From the repository root:
  Report (default): anonymous list of the files with detections + unscanned binaries by category/kind
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41l-triage.ps1
  Classify one detection (shape CLASSES only, never the value); use an id from the Report:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41l-triage.ps1 -Mode Classify -Id 1a2b3c4d
  GLB JSON-chunk metadata check (BIN chunks are not inspected; GLB stays unscanned):
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41l-triage.ps1 -Mode GlbMeta -PathContains fukushima

Nothing is changed, moved, deleted or sent. Nothing is approved: gates stay false. Paste only the printed text (no paths, no values).
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [ValidateSet('Report', 'Classify', 'GlbMeta')][string]$Mode = 'Report',
  [string]$Plan = '',
  [string]$Roots = '..',
  [string]$Id = '',
  [string]$Detector = 'jp-phone-number',
  [string]$PathContains = '',
  [int]$MaxFiles = 0
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41l-triage.cjs'
if (-not (Test-Path -LiteralPath $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
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

if ($Mode -eq 'Report') {
  $rep = Get-ChildItem -Path $planDir -Filter 'content-scan-report-*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $rep) { throw 'no content-scan-report-*.json in the plan folder. Run tools\mission41k-content-scan.ps1 first.' }
  $stateFile = Join-Path $planDir 'content-scan-state.json'
  $nodeArgs = @($tool, 'report', '--report', $rep.FullName, '--manifest', $manifest)
  if (Test-Path -LiteralPath $stateFile) { $nodeArgs += @('--state', $stateFile) }
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw ('triage report failed, exit ' + $LASTEXITCODE) }
  Write-Host 'Report only. To classify one detection: -Mode Classify -Id <id>. Nothing was approved.'
  exit 0
}

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
$stamp = [guid]::NewGuid().ToString('N')
$rootsFile = Join-Path $tmp ('livecity-roots41l-' + $stamp + '.json')
[System.IO.File]::WriteAllText($rootsFile, ($map | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

if ($Mode -eq 'Classify') {
  if ($Id -notmatch '^[0-9a-f]{8}$') { throw '-Id must be an 8-character hex id from the Report' }
  & node $tool 'classify' '--manifest' $manifest '--roots-file' $rootsFile '--id' $Id '--detector' $Detector
  if ($LASTEXITCODE -ne 0) { throw ('classify failed, exit ' + $LASTEXITCODE) }
  Write-Host 'Shape classes only. This is NOT a verdict: the owner must still check the file locally (see MISSION41L_README.md).'
  exit 0
}

# GlbMeta: cloud-only files (OneDrive) are listed and never opened.
$skipFile = Join-Path $tmp ('livecity-skip41l-' + $stamp + '.txt')
$lines = New-Object System.Collections.Generic.List[string]
foreach ($leaf in $map.Keys) {
  $base = $map[$leaf].TrimEnd('\')
  foreach ($f in (Get-ChildItem -LiteralPath $base -Recurse -File -Force -Filter '*.glb' -ErrorAction SilentlyContinue)) {
    $a = [int]$f.Attributes
    if ((($a -band 0x400000) -ne 0) -or (($a -band 0x40000) -ne 0) -or (($a -band 0x1000) -ne 0)) { $lines.Add($leaf + '/' + $f.FullName.Substring($base.Length + 1).Replace('\', '/')) }
  }
}
[System.IO.File]::WriteAllLines($skipFile, $lines.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('cloud-only glb files that will stay unread: ' + $lines.Count)
$nodeArgs = @($tool, 'glb-meta', '--manifest', $manifest, '--roots-file', $rootsFile, '--skip-file', $skipFile)
if (-not [string]::IsNullOrEmpty($PathContains)) { $nodeArgs += @('--path-contains', $PathContains) }
if ($MaxFiles -gt 0) { $nodeArgs += @('--max-files', [string]$MaxFiles) }
& node @nodeArgs
$code = $LASTEXITCODE
if ($code -ne 0 -and $code -ne 2) { throw ('glb-meta failed, exit ' + $code) }
Write-Host 'JSON chunk only; BIN chunks not inspected; GLB files stay unscanned. No gate was opened.'
exit 0
