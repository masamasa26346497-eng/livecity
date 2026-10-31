<#
Mission 40L: one command to preview a locally converted ward in the browser. ASCII only (Windows PowerShell 5.1).
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission40l-preview-local.ps1 -ExtRoot "..\livecity-3dtiles-out-fukushima"
  add -Check to run the HTTP self-test only. Nothing is copied, written or deleted.
#>
param(
  [Parameter(Mandatory = $true)][string]$ExtRoot,
  [string]$Ward = 'fukushima',
  [int]$Port = 8137,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$ExtRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $ExtRoot))
if (-not (Test-Path $ExtRoot)) { throw ('ExtRoot not found: ' + $ExtRoot) }
$nodeArgs = @((Join-Path $repo 'tools\mission40l-preview-local.cjs'), '--ext', $ExtRoot, '--ward', $Ward, '--port', $Port)
if ($Check) { $nodeArgs += '--check' }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw ('preview exited with code ' + $LASTEXITCODE) }
