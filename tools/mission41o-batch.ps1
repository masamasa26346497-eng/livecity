<#
Mission 41O: ONE command for the staged, READ-ONLY 41K content scan of ALL manifest files (slices of 5000, resumable) plus
anonymous progress and a fail-closed HOLD proposal. Offline. No upload, no network. Nothing is changed, moved, deleted or sent.
ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI). NOT run on real data yet (synthetic fixtures only).

From the repository root:
  One slice of 5000 files, then progress + proposal summary (run it again to continue; finished files are skipped):
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41o-batch.ps1
  Several slices in one go (0 = until every file is reached):
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41o-batch.ps1 -MaxSlices 0
  Progress only (no scanning):
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41o-batch.ps1 -Mode Progress
  Write a NEW hold proposal (ids only) into a NEW folder:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41o-batch.ps1 -Mode Propose -WriteProposalDir "..\livecity-hold-proposal"
  Check your existing 41F tars (headers only) against hold candidates; no tar is ever called safe:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41o-batch.ps1 -Mode TarCheck -TarDir "D:\path\to\41f-out"
  UUID-shape triage of building-tiles detections (candidate labels only, nothing is approved):
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41o-batch.ps1 -Mode UuidShape
  Turn a proposal into a 41N-compatible ids-only HOLD plan (holds files back, approves nothing):
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41o-batch.ps1 -Mode Approve -Proposal "..\livecity-hold-proposal\hold-proposal.json" -ConfirmHold -WriteProposalDir "..\livecity-exclusion-plan"
GLB (binary) JSON-chunk metadata is a separate stage: tools\mission41l-triage.ps1 -Mode GlbMeta.
The e6b68bd7 id is ALWAYS on the hold list. Gates stay false. Paste only the printed text (no paths, no values).
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [ValidateSet('Scan', 'Progress', 'Propose', 'TarCheck', 'UuidShape', 'Approve')][string]$Mode = 'Scan',
  [string]$Plan = '',
  [string]$Roots = '..',
  [int]$SliceSize = 5000,
  [int]$MaxSlices = 1,
  [string]$HoldId = '',
  [string]$TarDir = '',
  [string]$WriteProposalDir = '',
  [string]$Proposal = '',
  [switch]$ConfirmHold
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41o-holdplan.cjs'
$scanPs1 = Join-Path $repo 'tools\mission41k-content-scan.ps1'
if (-not (Test-Path -LiteralPath $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
if ($SliceSize -lt 100) { throw '-SliceSize must be at least 100' }
if ($HoldId -ne '' -and $HoldId -notmatch '^[0-9a-f]{8}(,[0-9a-f]{8})*$') { throw '-HoldId must be 8-character hex ids (comma separated)' }
$cwd = (Get-Location).Path
function Resolve-Abs([string]$p) {
  $p = $p.Trim().Trim('"')
  if ([System.IO.Path]::IsPathRooted($p)) { return [System.IO.Path]::GetFullPath($p) }
  return [System.IO.Path]::GetFullPath((Join-Path $cwd $p))
}
if ($Mode -eq 'Approve') {
  if ([string]::IsNullOrEmpty($Proposal) -or [string]::IsNullOrEmpty($WriteProposalDir)) { throw '-Proposal and -WriteProposalDir are required for Approve' }
  if (-not $ConfirmHold) { throw 'refused: pass -ConfirmHold (this only HOLDS files back; it approves nothing)' }
  & node $tool 'approve' '--proposal' (Resolve-Abs $Proposal) '--confirm-hold' '--out' (Resolve-Abs $WriteProposalDir)
  if ($LASTEXITCODE -ne 0) { throw ('approve failed, exit ' + $LASTEXITCODE) }
  exit 0
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

function Invoke-Progress {
  & node $tool 'progress' '--manifest' $manifest '--slice' ([string]$SliceSize)
  return $LASTEXITCODE
}
function Invoke-Propose {
  $a = @($tool, 'propose', '--manifest', $manifest)
  if ($HoldId -ne '') { $a += @('--hold-id', $HoldId) }
  if (-not [string]::IsNullOrEmpty($WriteProposalDir)) { $a += @('--write-dir', (Resolve-Abs $WriteProposalDir)) }
  & node @a
  $c = $LASTEXITCODE
  if ($c -ne 0 -and $c -ne 3) { throw ('propose failed, exit ' + $c) }
}

if ($Mode -eq 'Progress') {
  $c = Invoke-Progress
  if ($c -ne 0 -and $c -ne 3) { throw ('progress failed, exit ' + $c) }
  exit 0
}
if ($Mode -eq 'Propose') { Invoke-Propose; Write-Host 'Proposal only. Nothing was excluded. Unreviewed is not safe. All gates stay false.'; exit 0 }
if ($Mode -eq 'TarCheck') {
  if ([string]::IsNullOrEmpty($TarDir)) { throw '-TarDir is required for TarCheck' }
  $t = Resolve-Abs $TarDir
  if (-not (Test-Path -LiteralPath $t -PathType Container)) { throw 'tar folder not found' }
  $a = @($tool, 'tar-check', '--manifest', $manifest, '--tar-dir', $t)
  if ($HoldId -ne '') { $a += @('--hold-id', $HoldId) }
  & node @a
  $c = $LASTEXITCODE
  if ($c -ne 0 -and $c -ne 2) { throw ('tar-check failed, exit ' + $c) }
  if ($c -eq 2) { Write-Host 'A tar contains hold candidates: re-create it into a NEW folder with --exclude-plan. Tars were not touched.' }
  exit 0
}
if ($Mode -eq 'UuidShape') {
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
  $rootsFile = Join-Path $tmp ('livecity-roots41o-' + [guid]::NewGuid().ToString('N') + '.json')
  [System.IO.File]::WriteAllText($rootsFile, ($map | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  & node $tool 'uuid-shape' '--manifest' $manifest '--roots-file' $rootsFile
  if ($LASTEXITCODE -ne 0) { throw ('uuid-shape failed, exit ' + $LASTEXITCODE) }
  Write-Host 'Shape classes are candidate labels only. Nothing was approved or removed from the hold list.'
  exit 0
}

# Mode Scan: slices through the existing 41K one-command scanner (read-only, resumable, cloud-only files are not opened)
if (-not (Test-Path -LiteralPath $scanPs1)) { throw ('tool not found: ' + $scanPs1) }
$slice = 0
while ($true) {
  $slice++
  Write-Host ('--- slice ' + $slice + ' (up to ' + $SliceSize + ' new files) ---')
  & powershell -NoProfile -ExecutionPolicy Bypass -File $scanPs1 -Stage All -Manifest $manifest -Roots $Roots -MaxFiles $SliceSize
  if ($LASTEXITCODE -ne 0) { throw ('41K scan slice failed, exit ' + $LASTEXITCODE) }
  $c = Invoke-Progress
  if ($c -eq 0) { Write-Host 'Every manifest file has been reached (reached is not reviewed).'; break }
  if ($c -ne 3) { throw ('progress failed, exit ' + $c) }
  if ($MaxSlices -gt 0 -and $slice -ge $MaxSlices) { Write-Host 'Stopped after the requested slices. Run the same command again to continue.'; break }
}
Invoke-Propose
Write-Host 'Read-only. Nothing was uploaded, changed, moved or deleted. The proposal excludes nothing by itself. All gates stay false.'
exit 0
