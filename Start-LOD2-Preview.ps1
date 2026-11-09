# Mission 168: ASCII-ONLY on purpose. Windows PowerShell 5.1 reads BOM-less files as ANSI (cp932),
# which garbles UTF-8 Japanese and breaks string quoting (ParserError). Do NOT add non-ASCII characters here.
# Japanese diagnostics are printed by the Node launcher (tools/lod2/lod2-launch.mjs), which is encoding-safe.
#
# Usage:   .\Start-LOD2-Preview.ps1                (41-building preview)
#          .\Start-LOD2-Preview.ps1 -All           (all 10,698 LOD2 buildings)
#   If blocked by execution policy:
#          powershell -ExecutionPolicy Bypass -File .\Start-LOD2-Preview.ps1
# Options: -NoOpen / -Port 8153 / -ExtRoot "C:\path\ext-3dtiles" / -CheckOnly / -All
# The window blocks while the server runs (normal). Ctrl+C stops it. Nothing is deleted or overwritten.
param([int]$Port = 8152, [switch]$NoOpen, [switch]$CheckOnly, [switch]$All, [string]$ExtRoot = "")
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js 18 or later is required. Install it from https://nodejs.org/ and reopen PowerShell." -ForegroundColor Red
  exit 1
}
$launch = Join-Path $root "tools\lod2\lod2-launch.mjs"
if (-not (Test-Path $launch)) {
  Write-Host "LOD2 code not found in this folder: $root" -ForegroundColor Red
  Write-Host "You may be on another branch (e.g. PR24). See tools\lod2\README-LAUNCH.md and fetch mission152-lod2-parallel into a separate folder (git worktree add)." -ForegroundColor Yellow
  exit 1
}
$a = @($launch, "--port", "$Port")
if ($All) { $a += "--all" }
if ($NoOpen) { $a += "--no-open" }
if ($CheckOnly) { $a += "--check-only" }
if ($ExtRoot) { $a += @("--ext-root", $ExtRoot) }
& node @a
exit $LASTEXITCODE
