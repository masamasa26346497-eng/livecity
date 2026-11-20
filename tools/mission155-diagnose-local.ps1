# Mission 155: one-shot, READ-ONLY coverage diagnosis on the owner's PC. ASCII only (Windows PowerShell 5.1).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission155-diagnose-local.ps1
# Auto-detects (only if they exist): C:\lc141, %LOCALAPPDATA%\LiveCity-3DTiles-Out-24, ..\livecity-data-pipeline\...
# Optional: -Src <legacy buildings dir>  -Converted <converted root>  -Rendered <json copied from the diag panel>
# Writes only data\reports\mission155-coverage\audit-local.json (counts and tile keys; no building ids). Nothing is uploaded or deleted.
param([string]$Src = '', [string]$Converted = '', [string]$Rendered = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'data\reports\mission155-coverage\audit-local.json'
$argsList = @((Join-Path $root 'tools\mission155-coverage-audit.cjs'), '--auto', '--out', $out)
if ($Src -ne '') { $argsList += @('--src', $Src) }
if ($Converted -ne '') { $argsList += @('--converted', $Converted) }
if ($Rendered -ne '') { $argsList += @('--rendered', $Rendered) }
& node @argsList
if ($LASTEXITCODE -ne 0) { throw ('audit failed, exit ' + $LASTEXITCODE) }
Write-Host ''
Write-Host ('Result file: ' + $out)
Write-Host 'To add browser data: open the viewer with ?diag=1, select a ward, click the copy-JSON button in the panel,'
Write-Host 'save it to a file and re-run with -Rendered <file>.'
