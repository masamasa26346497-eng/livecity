<#
Mission 41S: ONE command, anonymous READ-ONLY triage of 41R findings. Offline. No upload, no network. Nothing is changed, moved, deleted or sent.
ASCII-only on purpose (Windows PowerShell 5.1). NOT run on real data (synthetic fixtures only).
From the repository root:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41s-triage.ps1 -Mode credential
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41s-triage.ps1 -Mode phone-groups
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41s-triage.ps1 -Mode contact-subclass -ProgressFile ..\41s-progress.json   (41T; read-only, writes nothing)
Options: -Plan <folder> (default: newest livecity-plan-* under TEMP), -Roots ".." (root folders, ';' separated), -Ids a,b (credential only),
         -Max 500 (phone-groups per-run cap), -ProgressFile <file> (phone-groups resume file; holds only anonymous id -> class).
Output: ids, categories, extensions, coarse shape classes and count buckets only. No values, key names, paths or context. Everything stays HOLD.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [ValidateSet('credential', 'phone-groups', 'contact-subclass')][string]$Mode = 'credential',
  [string]$Plan = '',
  [string]$Roots = '..',
  [string]$Ids = '',
  [int]$Max = 500,
  [string]$ProgressFile = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41s-triage.cjs'
if ($Mode -eq 'contact-subclass') { $tool = Join-Path $repo 'tools\mission41t-contact-subclass.cjs' }
if (-not (Test-Path -LiteralPath $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
if ($Max -lt 1) { throw '-Max must be 1 or more' }
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
$rootsFile = Join-Path $tmp ('livecity-roots41s-' + [guid]::NewGuid().ToString('N') + '.json')
[System.IO.File]::WriteAllText($rootsFile, ($map | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
$a = @($tool, $Mode, '--manifest', $manifest, '--roots-file', $rootsFile)
if ($Mode -eq 'contact-subclass') {
  if ([string]::IsNullOrEmpty($ProgressFile)) { throw '-ProgressFile (the 41S phone-groups resume file) is required for contact-subclass' }
  $a = @($tool, '--manifest', $manifest, '--roots-file', $rootsFile, '--progress-file', (Resolve-Abs $ProgressFile))
} elseif ($Mode -eq 'credential') {
  if (-not [string]::IsNullOrEmpty($Ids)) { $a += @('--ids', $Ids) }
} else {
  $a += @('--max', ([string]$Max))
  if (-not [string]::IsNullOrEmpty($ProgressFile)) { $a += @('--progress-file', (Resolve-Abs $ProgressFile)) }
}
& node @a | Out-Host
if ($LASTEXITCODE -ne 0) { throw ('triage failed, exit ' + $LASTEXITCODE) }
Write-Host 'Labels only. Nothing was approved, excluded or sent. uploadAllowed=false. All findings and unscanned files stay HOLD.'
