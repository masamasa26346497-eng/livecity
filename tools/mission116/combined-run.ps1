# Mission 116 one-shot for Windows PowerShell 5.1 (ASCII only): roads/water layers (45I/115) + private 2025 buildings (108/109/114) in ONE local viewer.
# Run from the repo root. Nothing is deleted, overwritten, copied into the repo or uploaded.
#   -Mode audit  : count OLD OSM source features per ward (reads -Src only)
#   -Mode build  : audit + generate layers into -LayersRoot (new files only; existing ward layers are skipped) + numeric verify
#   -Mode verify : numeric verify of -LayersRoot only
#   -Mode serve  : serve -BuildingsRoot (<ward>25 dirs) + -LayersRoot on 127.0.0.1 (loopback only)
#   -SupplementalLayersRoot : optional 2nd read-only layers root (e.g. the -v2 root holding a clipVersion 2 ward). A ward in both roots is served
#                  from the supplemental root only if it is clipVersion 2 and the primary copy is older; otherwise the server stops.
#                  -LayersPrefer primary|supplemental decides explicitly.
#   -Mode all    : audit, build, verify, serve (default)
param(
  [string]$Src = '..\livecity-data-pipeline\public\map-data\osaka-city',
  [string]$BuildingsRoot = 'temp\mission114\root',
  [string]$LayersRoot = '',
  [string]$SupplementalLayersRoot = '',
  [ValidateSet('','primary','supplemental')][string]$LayersPrefer = '',
  [string]$Wards = 'nishi,fukushima,yodogawa',
  [ValidateSet('audit','build','verify','diagnose','readiness','serve','all')][string]$Mode = 'all',
  [int]$Port = 8137
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node was not found in PATH' }
function Resolve-AbsPath([string]$p) {
  if ([System.IO.Path]::IsPathRooted($p)) { return [System.IO.Path]::GetFullPath($p) }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $p))
}
if ($LayersRoot -eq '') {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set. Pass an absolute -LayersRoot.' }
  $LayersRoot = Join-Path $env:LOCALAPPDATA 'LiveCity-MapLayers-Out-24'
}
$layers = Resolve-AbsPath $LayersRoot
Push-Location $repo
try {
  $needSrc = ($Mode -eq 'audit') -or ($Mode -eq 'build') -or ($Mode -eq 'all')
  if ($needSrc) {
    if (-not (Test-Path -LiteralPath $Src)) {
      Write-Host 'SOURCE NOT FOUND: the old OSM tiles (roads/waterways/parks/railways) must exist on this PC. Pass -Src with that folder. Nothing was generated.'
      exit 2
    }
    $srcAbs = (Resolve-Path -LiteralPath $Src).Path
    Write-Host '== 1. audit (source features per ward) =='
    & node tools\mission115\layers-run.cjs audit --src $srcAbs --wards $Wards
    if ($LASTEXITCODE -ne 0) { throw ('audit failed, exit ' + $LASTEXITCODE) }
  }
  if (($Mode -eq 'build') -or ($Mode -eq 'all')) {
    Write-Host '== 2. build + 3. verify (existing ward layers are skipped, not overwritten) =='
    & node tools\mission115\layers-run.cjs build --src $srcAbs --layers-root $layers --wards $Wards
    $b = $LASTEXITCODE
    if ($b -ne 0) { Write-Host ('build/verify reported problems (exit ' + $b + '). Wards that passed can still be viewed; see the list above.') }
  }
  if ($Mode -eq 'diagnose') {
    & node tools\mission115\layers-run.cjs diagnose --layers-root $layers --wards $Wards
    exit $LASTEXITCODE
  }
  if ($Mode -eq 'readiness') {
    # Mission 119: read-only 24-ward matrix + loopback HTTP check. Writes nothing.
    $rArgs = @('tools\mission119\readiness.cjs', '--buildings-root', (Resolve-AbsPath $BuildingsRoot), '--layers-root', $layers, '--http')
    if ($SupplementalLayersRoot -ne '') { $rArgs += @('--supplemental-layers-root', (Resolve-AbsPath $SupplementalLayersRoot)) }
    if ($LayersPrefer -ne '') { $rArgs += @('--layers-prefer', $LayersPrefer) }
    & node @rArgs
    exit $LASTEXITCODE
  }
  if ($Mode -eq 'verify') {
    & node tools\mission115\layers-run.cjs verify --layers-root $layers --wards $Wards
    exit $LASTEXITCODE
  }
  if (($Mode -eq 'serve') -or ($Mode -eq 'all')) {
    Write-Host '== 4. combined preview (2025 buildings + layers) =='
    $bld = Resolve-AbsPath $BuildingsRoot
    if (-not (Test-Path -LiteralPath $bld)) { Write-Host 'BUILDINGS ROOT NOT FOUND: fetch the 2025 buildings first (tools\mission114\local-run.mjs). Nothing served.'; exit 2 }
    $srvArgs = @('tools\mission116\combined-server.cjs', '--buildings-root', $bld, '--layers-root', $layers, '--port', ([string]$Port))
    if ($SupplementalLayersRoot -ne '') { $srvArgs += @('--supplemental-layers-root', (Resolve-AbsPath $SupplementalLayersRoot)) }
    if ($LayersPrefer -ne '') { $srvArgs += @('--layers-prefer', $LayersPrefer) }
    & node @srvArgs
    exit $LASTEXITCODE
  }
} finally { Pop-Location }
