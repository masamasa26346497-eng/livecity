<#
Mission 41A: read-only inventory of local Live City data (counts, sizes, >100MB files, secret candidates,
duplicates) and a private-repo upload PLAN. Nothing is uploaded, copied, moved or deleted.
NOTE: this file is intentionally ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
One command, from the repository root. Scan the whole LiveCity parent folder:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41a-inventory.ps1 -Roots ".."
Several folders: separate with semicolons inside ONE quoted string (with -File, commas are NOT array separators):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41a-inventory.ps1 -Roots "..\livecity-data-pipeline;..\livecity-3dtiles-out-fukushima"
Space-separated extra folders are also accepted as additional roots; they are never taken as OutDir.
Optional: -Hash (sha256, confirms duplicates; slow on many GB), -OutDir <folder> (must be named, and outside every root).
Output (default: new folder under %TEMP%, outside every root): inventory.json, upload-plan.json, report.md.
Do NOT commit the output: file paths may contain personal info.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Roots,
  [string]$OutDir = '',
  [switch]$Hash
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41a-inventory.cjs'
if (-not (Test-Path $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$rootList = @()
foreach ($item in $Roots) {
  foreach ($piece in ($item -split '[;,]')) {
    $t = $piece.Trim().Trim('"')
    if ($t.Length -gt 0) { $rootList += $t }
  }
}
if ($rootList.Count -eq 0) { throw 'no roots given' }
$full = @()
foreach ($r in $rootList) {
  $p = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $r))
  if (-not (Test-Path $p -PathType Container)) { throw ('root not found: ' + $p) }
  $full += $p
}
if ([string]::IsNullOrEmpty($OutDir)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) ('livecity-inventory-' + $stamp)
}
if ([System.IO.Path]::IsPathRooted($OutDir)) {
  $OutDir = [System.IO.Path]::GetFullPath($OutDir)
} else {
  $OutDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutDir))
}
foreach ($f in $full) {
  $rootNorm = $f.TrimEnd('\') + '\'
  $outNorm = $OutDir.TrimEnd('\') + '\'
  if ($outNorm.StartsWith($rootNorm, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw ('OutDir must be outside every scanned root. OutDir=' + $OutDir + ' root=' + $f + ' (omit -OutDir to use %TEMP%)')
  }
}
$nodeArgs = @($tool, '--roots', ($full -join ';'), '--out', $OutDir)
if ($Hash) { $nodeArgs += '--hash' }
Write-Host ('Scanning (read-only): ' + ($full -join ' | '))
Write-Host ('Output folder (outside roots): ' + $OutDir)
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw ('inventory failed, exit code ' + $LASTEXITCODE) }
Write-Host ('Done. Open: ' + (Join-Path $OutDir 'report.md'))
Write-Host 'Paste the "Totals", "GitHub limits" and "Upload plan" sections of report.md into the PR. Secret values are never recorded.'
