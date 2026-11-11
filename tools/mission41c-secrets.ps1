<#
Mission 41C: safe secret review. Never prints or stores a secret value; read-only. ASCII-only (PS 5.1).
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41c-secrets.ps1 -Roots ".."
Uses the newest %TEMP%\livecity-inventory-* unless -Inventory is given. Output: new folder under %TEMP%.
Paste only the printed counts. Do NOT paste LOCAL-ONLY-id-to-path.json.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)][string]$Roots,
  [string]$Inventory = '',
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41c-secret-review.cjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$tmp = [System.IO.Path]::GetTempPath()
if ([string]::IsNullOrEmpty($Inventory)) {
  $dirs = Get-ChildItem -Path $tmp -Directory -Filter 'livecity-inventory-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  foreach ($d in $dirs) {
    $cand = Join-Path $d.FullName 'inventory.json'
    if (Test-Path $cand) { $Inventory = $cand; break }
  }
}
if ([string]::IsNullOrEmpty($Inventory) -or -not (Test-Path $Inventory)) { throw 'inventory.json not found. Pass -Inventory <path>.' }
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $tmp ('livecity-secrets-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$full = @()
foreach ($piece in ($Roots -split ';')) {
  $t = $piece.Trim().Trim('"')
  if ($t.Length -gt 0) { $full += [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $t)) }
}
& node $tool '--inventory' ([System.IO.Path]::GetFullPath($Inventory)) '--roots' ($full -join ';') '--out' ([System.IO.Path]::GetFullPath($OutDir))
if ($LASTEXITCODE -ne 0) { throw ('secret review failed, exit code ' + $LASTEXITCODE) }
Write-Host ('Report folder: ' + $OutDir)
