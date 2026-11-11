<#
Mission 46B: one-command READ-ONLY visual-offset QA for all 24 wards on this PC. ASCII only (Windows PowerShell 5.1).
Nothing is changed, moved, converted, uploaded or deleted. No network. Output: counts / percentages / metres only.
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission46b-visual-offset-qa.ps1 -Src "..\livecity-data-pipeline\public\map-data\osaka-city"
Optional: -Wards fukushima,kita   -Out "C:\somewhere\new\report.json" (must not exist, must be outside -Src)
#>
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [string]$Wards = '',
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$argsList = @((Join-Path $repo 'tools\mission46b-visual-offset-qa.cjs'), '--src', $Src)
if ($Wards -ne '') { $argsList += @('--wards', $Wards) }
if ($Out -ne '') { $argsList += @('--out', $Out) }
& node @argsList
exit $LASTEXITCODE
