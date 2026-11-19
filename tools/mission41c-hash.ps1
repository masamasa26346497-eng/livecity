<#
Mission 41C: staged sha256 of ONLY duplicate candidates >= 50 MB (read-only, resumable, no upload).
ASCII-only (Windows PowerShell 5.1).
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41c-hash.ps1 -Roots ".."
Same -Roots you gave tools\mission41a-inventory.ps1. Uses the newest %TEMP%\livecity-inventory-* unless -Inventory is given.
Optional: -MinMB 50, -MaxGB 40 (stop after reading this many GiB; run again to continue, the cache is kept).
The cache is %TEMP%\livecity-hashes.json (outside every root). Then run tools\mission41c-quick.ps1 -Hashes <that file>.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)][string]$Roots,
  [string]$Inventory = '',
  [int]$MinMB = 50,
  [int]$MaxGB = 0,
  [string]$Cache = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41c-hash-candidates.cjs'
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
if ([string]::IsNullOrEmpty($Cache)) { $Cache = Join-Path $tmp 'livecity-hashes.json' }
$full = @()
foreach ($piece in ($Roots -split ';')) {
  $t = $piece.Trim().Trim('"')
  if ($t.Length -gt 0) { $full += [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $t)) }
}
$nodeArgs = @($tool, '--inventory', [System.IO.Path]::GetFullPath($Inventory), '--roots', ($full -join ';'), '--cache', [System.IO.Path]::GetFullPath($Cache), '--min-mb', [string]$MinMB)
if ($MaxGB -gt 0) { $nodeArgs += @('--max-gb', [string]$MaxGB) }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw ('hashing failed, exit code ' + $LASTEXITCODE) }
Write-Host ('Cache: ' + $Cache)
