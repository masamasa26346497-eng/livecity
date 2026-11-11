<#
Mission 41H: pre-transfer gates. Offline, read-only. ASCII-only (Windows PowerShell 5.1). Prints no paths, no secret values.
  -Action secrets-summary -Review <secret-review.json>
  -Action licence-ledger  [-Manifest <manifest.json>] -Ledger <new file>
  -Action licence-check   [-Manifest <manifest.json>] -Ledger <file>
  -Action zip-keys        -Zip <archive.zip>
  -Action gates-status    [-Manifest <manifest.json>] [-Ledger <file>] [-Review <file>]
Manifest defaults to the newest %TEMP%\livecity-plan-*\manifest.json. No gate is ever opened by this script.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)][ValidateSet('secrets-summary', 'licence-ledger', 'licence-check', 'zip-keys', 'gates-status')][string]$Action,
  [string]$Manifest = '',
  [string]$Ledger = '',
  [string]$Review = '',
  [string]$Zip = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41h-gates.cjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$cwd = (Get-Location).Path
function Resolve-Abs([string]$p) {
  $p = $p.Trim().Trim('"')
  if ([System.IO.Path]::IsPathRooted($p)) { return [System.IO.Path]::GetFullPath($p) }
  return [System.IO.Path]::GetFullPath((Join-Path $cwd $p))
}
if (($Action -eq 'licence-ledger' -or $Action -eq 'licence-check' -or $Action -eq 'gates-status') -and [string]::IsNullOrEmpty($Manifest)) {
  $dirs = Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Directory -Filter 'livecity-plan-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  foreach ($d in $dirs) {
    $cand = Join-Path $d.FullName 'manifest.json'
    if (Test-Path -LiteralPath $cand) { $Manifest = $cand; break }
  }
  if ([string]::IsNullOrEmpty($Manifest)) { throw 'no livecity-plan-*\manifest.json under TEMP. Pass -Manifest.' }
}
$a = @($tool, $Action)
if ($Manifest) { $a += @('--manifest', (Resolve-Abs $Manifest)) }
if ($Ledger) {
  if ($Action -eq 'licence-ledger') { $a += @('--out', (Resolve-Abs $Ledger)) } else { $a += @('--ledger', (Resolve-Abs $Ledger)) }
}
if ($Review) { $a += @('--review', (Resolve-Abs $Review)) }
if ($Zip) { $a += @('--zip', (Resolve-Abs $Zip)) }
& node @a
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host ('exit code ' + $code + ' (for licence-check, 2 means the ledger is not complete yet)') }
exit $code
