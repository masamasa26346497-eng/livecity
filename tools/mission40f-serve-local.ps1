<#
Mission 40F: start the local read-only preview server with a locally converted ward tileset.
ASCII only; keep it ASCII for Windows PowerShell 5.1.
Usage (repo root):
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission40f-serve-local.ps1 -ExtRoot "..\livecity-3dtiles-out-fukushima"
Nothing is copied, written or deleted. Press Ctrl+C to stop.
#>
param(
  [Parameter(Mandatory = $true)][string]$ExtRoot,
  [int]$Port = 8137
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$ExtRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $ExtRoot))
if (-not (Test-Path $ExtRoot)) { throw ('ExtRoot not found: ' + $ExtRoot) }
& node (Join-Path $repo 'tools\mission40f-serve-local.cjs') --ext $ExtRoot --port $Port
if ($LASTEXITCODE -ne 0) { throw ('server exited with code ' + $LASTEXITCODE) }
