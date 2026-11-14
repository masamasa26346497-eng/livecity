<#
Mission 41J: ONE command for the smallest review step. Read-only; writes ONE new report file in %TEMP%.
ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI). Opens no gate, uploads nothing.
Run from the repository root:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41j-review.ps1
With a 41B manifest (and a 41C secret-review.json) it also runs the pack leak check:
  ... -File tools\mission41j-review.ps1 -Manifest "<manifest.json>" -Review "<secret-review.json>"
Printed text has no paths and no values.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Manifest = '',
  [string]$Review = '',
  [string]$AlsoReview = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41j-provenance.cjs'
if (-not (Test-Path $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$out = Join-Path ([System.IO.Path]::GetTempPath()) ('livecity-provenance-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
Write-Host '--- 1. provenance candidates (repo text only, nothing approved) ---'
& node $tool provenance --repo $repo --out $out
if ($LASTEXITCODE -ne 0) { throw ('provenance failed, exit ' + $LASTEXITCODE) }
Write-Host '--- 2. use scopes ---'
& node $tool scopes
if (-not [string]::IsNullOrEmpty($Manifest)) {
  Write-Host '--- 3. pack leak check ---'
  $a = @($tool, 'leak-check', '--manifest', [System.IO.Path]::GetFullPath($Manifest))
  if (-not [string]::IsNullOrEmpty($Review)) { $a += @('--review', [System.IO.Path]::GetFullPath($Review)) }
  if (-not [string]::IsNullOrEmpty($AlsoReview)) { $a += @('--also-review', [System.IO.Path]::GetFullPath($AlsoReview)) }
  & node @a
  if ($LASTEXITCODE -eq 2) { Write-Host 'LEAK-RISK found: do not pack until the listed ids are removed.' }
  elseif ($LASTEXITCODE -ne 0) { throw ('leak-check failed, exit ' + $LASTEXITCODE) }
}
Write-Host ('Report file (new): ' + $out)
Write-Host 'No gate was opened. Fill the 41H licence ledger and 41I review ledger by hand.'
