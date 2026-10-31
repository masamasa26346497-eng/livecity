<#
Mission 45D: convert ALL 24 wards to LOCAL 3D Tiles on this PC. ASCII only (Windows PowerShell 5.1).
Nothing is uploaded, committed, served or deleted. Source is read-only. Output goes to a NEW folder outside the repository and outside OneDrive (default: %LOCALAPPDATA%\LiveCity-3DTiles-Out-24).
The source argument is -LegacyBuildings (there is no -Src).
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
  [string]$OutRoot = '',
  [switch]$Execute,
  [switch]$Approved
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
function Resolve-AbsPath([string]$p) {
  if ([System.IO.Path]::IsPathRooted($p)) { return [System.IO.Path]::GetFullPath($p) }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $p))
}
function Get-SyncRoots {
  $roots = @()
  foreach ($v in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) { if ($v) { $roots += $v } }
  if ($env:USERPROFILE) {
    $roots += (Join-Path $env:USERPROFILE 'OneDrive')
    foreach ($d in @(Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Filter 'OneDrive*' -ErrorAction SilentlyContinue)) { $roots += $d.FullName }
  }
  $norm = @()
  foreach ($r in $roots) { $norm += ([System.IO.Path]::GetFullPath($r).TrimEnd('\') + '\') }
  return ($norm | Select-Object -Unique)
}
function Test-UnderSyncRoot([string]$p) {
  $q = $p.TrimEnd('\') + '\'
  foreach ($r in (Get-SyncRoots)) { if ($q.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)) { return $true } }
  return $false
}
$src = Resolve-AbsPath $LegacyBuildings
if ($OutRoot -eq '') {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set; cannot choose a non-synced default output folder. Pass an absolute -OutRoot outside OneDrive.' }
  $out = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'LiveCity-3DTiles-Out-24'))
} else { $out = Resolve-AbsPath $OutRoot }
if (-not (Test-Path -LiteralPath $src)) { throw 'Source folder not found. Pass -LegacyBuildings with an existing folder. (path not shown on purpose)' }
if (Test-UnderSyncRoot $out) {
  if ($Step -eq 'convert') { throw 'Output folder is inside a OneDrive sync root; generated tiles could be uploaded automatically. Use a folder outside OneDrive (default is under LOCALAPPDATA). Nothing was done.' }
  Write-Host 'WARNING: output folder is inside a OneDrive sync root. convert will refuse this. Use a non-synced -OutRoot.'
}
if (Test-Path -LiteralPath $out) {
  $it = Get-Item -LiteralPath $out -Force
  if (($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Output folder is a reparse point/symlink; refusing.' }
}
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
