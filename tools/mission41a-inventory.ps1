<#
Mission 41A: read-only inventory of local Live City data (counts, sizes, >100MB files, secret candidates,
duplicates) and a private-repo upload PLAN. Nothing is uploaded, copied, moved or deleted.
NOTE: this file is intentionally ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
One command, from the repository root (separate several folders with commas):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41a-inventory.ps1 -Roots "..\livecity-data-pipeline","..\livecity-3dtiles-out-fukushima"
Optional: -Hash (sha256, confirms duplicates; slow on many GB), -OutDir <new folder>.
Output (default: sibling folder of the repo, outside every root): inventory.json, upload-plan.json, report.md.
Do NOT commit the output: file paths may contain personal info.
#>
param(
  [Parameter(Mandatory = $true)][string[]]$Roots,
  [string]$OutDir = '',
  [switch]$Hash
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41a-inventory.cjs'
if (-not (Test-Path $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$full = @()
foreach ($r in $Roots) {
  $p = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $r))
  if (-not (Test-Path $p -PathType Container)) { throw ('root not found: ' + $p) }
  $full += $p
}
if ([string]::IsNullOrEmpty($OutDir)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $OutDir = Join-Path (Split-Path -Parent $repo) ('livecity-inventory-' + $stamp)
}
$OutDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutDir))
$nodeArgs = @($tool, '--roots', ($full -join ';'), '--out', $OutDir)
if ($Hash) { $nodeArgs += '--hash' }
Write-Host ('Scanning (read-only): ' + ($full -join ' | '))
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw ('inventory failed, exit code ' + $LASTEXITCODE) }
Write-Host ('Done. Open: ' + (Join-Path $OutDir 'report.md'))
Write-Host 'Paste the "Totals", "GitHub limits" and "Upload plan" sections of report.md into the PR. Secret values are never recorded.'
