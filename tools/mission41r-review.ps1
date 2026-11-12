<#
Mission 41R: ONE command, anonymous READ-ONLY review summary of the final 41K scan state. Offline. No upload, no network.
Nothing is changed, moved, deleted or sent. ASCII-only on purpose (Windows PowerShell 5.1). NOT run on real data (synthetic fixtures only).
From the repository root:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41r-review.ps1
Options: -Plan <folder> (default: newest livecity-plan-* under TEMP), -MaxIds 12 (0..50), -WriteDir <NEW folder> (saves review-summary.json),
         -Shape -Roots "..": also reads local files to label phone-like hits (candidate labels only; slower).
Output is counts and capped anonymous ids only. uploadAllowed is always false. Gates stay false.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Plan = '',
  [string]$Roots = '..',
  [int]$MaxIds = 12,
  [string]$WriteDir = '',
  [switch]$Shape
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41r-review-summary.cjs'
if (-not (Test-Path -LiteralPath $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
if ($MaxIds -lt 0 -or $MaxIds -gt 50) { throw '-MaxIds must be 0..50' }
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
$a = @($tool, '--manifest', $manifest, '--max-ids', ([string]$MaxIds))
if (-not [string]::IsNullOrEmpty($WriteDir)) { $a += @('--write-dir', (Resolve-Abs $WriteDir)) }
if ($Shape) {
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
  $rootsFile = Join-Path $tmp ('livecity-roots41r-' + [guid]::NewGuid().ToString('N') + '.json')
  [System.IO.File]::WriteAllText($rootsFile, ($map | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  $a += @('--shape', '--roots-file', $rootsFile)
}
& node @a | Out-Host
if ($LASTEXITCODE -ne 0) { throw ('review summary failed, exit ' + $LASTEXITCODE) }
Write-Host 'Summary only. Nothing was approved, excluded or sent. uploadAllowed=false. Findings and unscanned files stay HOLD.'
