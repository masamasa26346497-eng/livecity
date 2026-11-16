<#
Mission 160: audit + serve the locally built Nishi 2025 tileset on 127.0.0.1. ASCII only (Windows PowerShell 5.1).
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission160-nishi2025-start.ps1 -Root "temp\mission79"
<Root>\nishi-2025\tileset.json must exist. Nothing is copied, moved, deleted or re-downloaded.
#>
param([string]$Root = 'temp\mission79', [int]$Port = 8137)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (22+) was not found in PATH' }
$Root = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Root))
& node (Join-Path $repo 'tools\mission160-nishi2025-start.cjs') --root $Root --port $Port
if ($LASTEXITCODE -ne 0) { throw ('exited with code ' + $LASTEXITCODE) }
