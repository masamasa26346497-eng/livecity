<#
Mission 45C: one wrapper for the PC-only ward flow. ASCII only (Windows PowerShell 5.1). Nothing is uploaded, committed or deleted.
Default step is 'plan' = read-only preflight + 43F DRY-RUN for ONE ward (default fukushima). Nothing is created or converted.
Steps:
  plan     read-only audit of the source + 43F dry-run (creates nothing)
  convert  needs -Execute AND -Approved. Converts into a NEW folder outside the repo (existing files are never overwritten)
  verify   read-only 43G re-verification of the output + coverage (source vs converted)
  preview  127.0.0.1-only viewer for verified wards
Three commands, from the repo root:
  1) powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45c-ward-flow.ps1
  2) powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45c-ward-flow.ps1 -Step convert -Execute -Approved
  3) powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45c-ward-flow.ps1 -Step preview
Other wards: -Wards a,b  (staged; do not use all 23 at once). Known cautions: higashiyodogawa (height sentinel), abeno/suminoe/
sumiyoshi/higashisumiyoshi/nishinari (cross-ward id collisions) follow the 40D/40E policy.
#>
param(
  [ValidateSet('plan','convert','verify','preview')][string]$Step = 'plan',
  [string]$LegacyBuildings = '..\livecity-data-pipeline\public\map-data\osaka-city\buildings',
  [string]$OutRoot = '..\livecity-3dtiles-out',
  [string]$Wards = 'fukushima',
  [switch]$Execute,
  [switch]$Approved
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) was not found in PATH' }
$src = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LegacyBuildings))
$out = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutRoot))
function Run-Node([string[]]$a) {
  & node @a | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Host ('RESULT: NOT OK (exit ' + $LASTEXITCODE + '). Source data was not modified.'); exit $LASTEXITCODE }
}
if (-not (Test-Path -LiteralPath $src)) { throw ('Source folder not found. Pass -LegacyBuildings. Looked for: ' + $src) }
if ($Step -eq 'plan') {
  Write-Host '== preflight: read-only audit of the source (counts only) =='
  Run-Node @((Join-Path $repo 'tools\mission43d-ward-batch.cjs'), 'audit', '--src', $src)
  Write-Host '== 43F dry-run (nothing is created) =='
  Run-Node @((Join-Path $repo 'tools\mission43f-pc-convert.cjs'), '--src', $src, '--out-root', $out, '--wards', $Wards)
  Write-Host 'Next: add -Step convert -Execute -Approved only after you approve a local conversion.'
}
elseif ($Step -eq 'convert') {
  if (-not ($Execute -and $Approved)) { throw 'convert needs both -Execute and -Approved (explicit owner approval). Nothing was done.' }
  Run-Node @((Join-Path $repo 'tools\mission43f-pc-convert.cjs'), '--src', $src, '--out-root', $out, '--wards', $Wards, '--execute')
  Run-Node @((Join-Path $repo 'tools\mission43g-verify-local.cjs'), '--out-root', $out, '--src', $src, '--wards', $Wards)
}
elseif ($Step -eq 'verify') {
  Run-Node @((Join-Path $repo 'tools\mission43g-verify-local.cjs'), '--out-root', $out, '--src', $src, '--wards', $Wards)
  foreach ($w in $Wards.Split(',')) {
    Run-Node @((Join-Path $repo 'tools\mission45c-coverage.cjs'), '--src', $src, '--converted', $out, '--ward', $w.Trim(), '--kind', 'real')
  }
}
else {
  Run-Node @((Join-Path $repo 'tools\mission43g-local-preview.cjs'), '--out-root', $out, '--src', $src, '--wards', $Wards, '--serve')
}
Write-Host 'This is not a licence, privacy or publication approval; uploadAllowed stays 0.'
exit 0
