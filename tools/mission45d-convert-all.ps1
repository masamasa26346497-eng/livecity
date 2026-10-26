<#
Mission 45D: convert ALL 24 wards to LOCAL 3D Tiles on this PC. ASCII only (Windows PowerShell 5.1).
Nothing is uploaded, committed, served or deleted. Source is read-only. Output goes to a NEW folder outside the repository.
Default is a strict read-only PLAN. Converting needs BOTH -Execute and -Approved.
Three commands, from the repo root (use the worktree that contains this file; Sumiyoshi is rebuilt from the Git-tracked tiles):
  1) plan    powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45d-convert-all.ps1
  2) convert powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45d-convert-all.ps1 -Step convert -Execute -Approved
  3) verify  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45d-convert-all.ps1 -Step verify
Re-run step 2 after an interruption: wards that are already verified are not converted again.
"complete" in the output means LOCAL CONVERSION ONLY. It is not browser display of 24 wards and not permission to publish.
#>
param(
  [ValidateSet('plan','convert','verify')][string]$Step = 'plan',
  [string]$LegacyBuildings = '..\livecity-data-pipeline\public\map-data\osaka-city\buildings',
  [string]$OutRoot = '..\livecity-3dtiles-out-24',
  [switch]$Execute,
  [switch]$Approved
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$src = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LegacyBuildings))
$out = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutRoot))
if (-not (Test-Path -LiteralPath $src)) { throw ('Source folder not found. Pass -LegacyBuildings. Looked for: ' + $src) }
$tool = Join-Path $repo 'tools\mission45d-convert-all.cjs'
$nodeArgs = @($tool, '--src', $src, '--out-root', $out)
if ($Step -eq 'convert') {
  if (-not ($Execute -and $Approved)) { throw 'convert needs both -Execute and -Approved (explicit owner approval). Nothing was done.' }
  $nodeArgs += @('--execute', '--approved')
  Write-Host 'EXECUTE: converting 24 wards into a local folder only (no upload). This can take a while.'
}
elseif ($Step -eq 'verify') { $nodeArgs += '--verify-only' }
else { Write-Host 'PLAN (default): read-only. Nothing is created or converted.' }
# Out-Host keeps node stdout out of the pipeline so it cannot be mixed with $LASTEXITCODE handling.
& node @nodeArgs | Out-Host
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host ('RESULT: NOT OK / NOT COMPLETE (exit ' + $code + '). Source data was not modified. Paste the JSON above (no paths or ids).'); exit $code }
Write-Host 'RESULT: ok. Local conversion status only; not a licence, privacy or publication approval; uploadAllowed stays 0.'
exit 0
