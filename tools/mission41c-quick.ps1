<#
Mission 41C: ONE command, no PC rescan. Reads the existing 41A inventory.json and prints an anonymous
summary + the 41B dry-run plan. Nothing is uploaded, copied, moved or deleted. ASCII-only on purpose
(Windows PowerShell 5.1 reads BOM-less files as ANSI).

Run from the repository root:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41c-quick.ps1

It automatically uses the NEWEST %TEMP%\livecity-inventory-*\inventory.json. To pick one:
  ... -File tools\mission41c-quick.ps1 -Inventory "C:\path\to\inventory.json"

Optional:
  -Hashes <hashes.json>   sha256 results from tools\mission41c-hash.ps1 (confirms duplicates)
  -Include "plateau-raw,dem-raw,photos-unverified-rights"   also plan deferred categories (still approved:false)
Output (new folder under %TEMP%): manifest.json, plan.md, deferred-ledger.json, anonymous-summary.json ...
The text printed on screen has no file paths and no secret values: it is safe to paste.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Inventory = '',
  [string]$Hashes = '',
  [string]$Include = '',
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission41b-plan.cjs'
if (-not (Test-Path $tool)) { throw ('tool not found: ' + $tool) }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$tmp = [System.IO.Path]::GetTempPath()
if ([string]::IsNullOrEmpty($Inventory)) {
  $dirs = Get-ChildItem -Path $tmp -Directory -Filter 'livecity-inventory-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  foreach ($d in $dirs) {
    $cand = Join-Path $d.FullName 'inventory.json'
    if (Test-Path $cand) { $Inventory = $cand; break }
  }
}
if ([string]::IsNullOrEmpty($Inventory) -or -not (Test-Path $Inventory)) { throw 'inventory.json not found. Pass -Inventory <path> (made by tools\mission41a-inventory.ps1).' }
$Inventory = [System.IO.Path]::GetFullPath($Inventory)
if ([string]::IsNullOrEmpty($OutDir)) {
  $OutDir = Join-Path $tmp ('livecity-plan-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$nodeArgs = @($tool, 'quick', '--inventory', $Inventory, '--out', $OutDir)
if (-not [string]::IsNullOrEmpty($Hashes)) { $nodeArgs += @('--hashes', [System.IO.Path]::GetFullPath($Hashes)) }
if (-not [string]::IsNullOrEmpty($Include)) { $nodeArgs += @('--include', $Include) }
Write-Host 'Reading inventory (read-only). No PC rescan.'
& node @nodeArgs
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host ('plan validation reported a problem, exit code ' + $code) }
Write-Host ('Details folder: ' + $OutDir)
Write-Host 'Paste only the text printed above. Do not paste file paths from the details folder.'
