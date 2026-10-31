<#
Mission 41K: ONE command for the READ-ONLY content scan of the 41B manifest files. Offline. No upload, no network.
ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).
NOT run on real data yet (synthetic fixtures only).

Stage 1 (default, the Fukushima subset), from the repository root:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41k-content-scan.ps1
Stage 2 (all manifest files, resumable; run it again to continue after a stop):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41k-content-scan.ps1 -Stage All
Optional: -MaxFiles 5000 / -MaxSeconds 1800 to work in slices, -PathContains <text>, -Manifest <file>, -Roots ".." (single LiveCity root).

What it does: finds the newest %TEMP%\livecity-plan-*\manifest.json, reads each listed file in streaming chunks and counts
key / credential / e-mail / phone patterns. Source files are only READ (never changed, moved, deleted).
Files that OneDrive keeps cloud-only are NOT opened (opening would download them); they stay "unscanned".
Binary and archive files (glb, pbf, zip, images ...) cannot be inspected: they are reported "unscanned", never "safe".
Console and report show only anonymous ids, categories, detector names and counts. No paths, no snippets, no values.
The state file (next to the manifest) holds ids, sizes and times only, so a re-run skips unchanged files.
The gates noSecretsReviewed / noPersonalDataReviewed / readyToUpload always stay false: a human must review.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Manifest = '',
  [string]$Roots = '..',
  [ValidateSet('Fukushima', 'All')][string]$Stage = 'Fukushima',
  [string]$PathContains = '',
  [int]$MaxFiles = 0,
  [int]$MaxSeconds = 0,
  [switch]$NoCloudCheck
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41k-content-scan.cjs'
if (-not (Test-Path -LiteralPath $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$cwd = (Get-Location).Path
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
$rootsFile = Join-Path $tmp ('livecity-roots41k-' + $stamp + '.json')
[System.IO.File]::WriteAllText($rootsFile, ($map | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
$skipFile = ''
if (-not $NoCloudCheck) {
  Write-Host 'Listing cloud-only (not downloaded) files so they are not opened ...'
  $skipFile = Join-Path $tmp ('livecity-skip41k-' + $stamp + '.txt')
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($leaf in $map.Keys) {
    $base = $map[$leaf].TrimEnd('\')
    foreach ($f in (Get-ChildItem -LiteralPath $base -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      $a = [int]$f.Attributes
      if ((($a -band 0x400000) -ne 0) -or (($a -band 0x40000) -ne 0) -or (($a -band 0x1000) -ne 0)) {
        $lines.Add($leaf + '/' + $f.FullName.Substring($base.Length + 1).Replace('\', '/'))
      }
    }
  }
  [System.IO.File]::WriteAllLines($skipFile, $lines.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ('cloud-only files that will stay unscanned: ' + $lines.Count)
}
if ([string]::IsNullOrEmpty($PathContains) -and $Stage -eq 'Fukushima') { $PathContains = 'fukushima' }
$nodeArgs = @($tool, 'scan', '--manifest', $Manifest, '--roots-file', $rootsFile)
if (-not [string]::IsNullOrEmpty($PathContains)) { $nodeArgs += @('--path-contains', $PathContains) }
if ($MaxFiles -gt 0) { $nodeArgs += @('--max-files', [string]$MaxFiles) }
if ($MaxSeconds -gt 0) { $nodeArgs += @('--max-seconds', [string]$MaxSeconds) }
if ($skipFile -ne '') { $nodeArgs += @('--skip-file', $skipFile) }
Write-Host 'Read-only content scan. Nothing is uploaded, changed, moved or deleted.'
& node @nodeArgs
$code = $LASTEXITCODE
if ($code -eq 2) { Write-Host 'DETECTIONS found: review the listed ids by hand (tools\mission41k-content-scan.cjs lookup --id <id> prints one path locally).' }
elseif ($code -eq 3) { Write-Host 'No detections in scanned files, but some files were NOT scanned (see unscannedByReason). Unscanned is not safe.' }
elseif ($code -ne 0) { throw ('content scan failed, exit ' + $code) }
Write-Host 'No gate was opened. Paste only the text printed above (it has no paths and no values).'
exit 0
