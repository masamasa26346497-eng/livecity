<#
Mission 40C: 旧 Live City の建物タイルを「コピーせず・読み取り専用で」検証し、Cesium 用 3D Tiles に一括変換する。
  - 元データ (-LegacyBuildings) は一切書き換え・削除・コピーしない（Node が直接 read する）。
  - 出力 (-OutRoot) は既存ファイルがあれば中止（上書き・削除しない）。巨大ファイルを Git に入れないため、既定はリポジトリ外。
使い方（リポジトリのルートで）:
  powershell -ExecutionPolicy Bypass -File tools\mission40c-run-local.ps1 `
     -LegacyBuildings "C:\path\to\livecity-data-pipeline\public\map-data\osaka-city\buildings"
  -Validate のみ:   ... -Mode validate
  -Mode inventory / validate / convert（既定 all = validate → inventory → convert）
#>
param(
  [Parameter(Mandatory = $true)][string]$LegacyBuildings,
  [string]$OutRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '..\livecity-3dtiles-out'),
  [ValidateSet('all', 'validate', 'inventory', 'convert')][string]$Mode = 'all'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'tools\mission40b-legacy-tiles-batch.cjs'
if (-not (Test-Path $tool)) { throw "tool not found: $tool" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node (18+) が見つかりません' }
if (-not (Test-Path (Join-Path $LegacyBuildings 'manifest.json'))) { throw "manifest.json が $LegacyBuildings にありません（buildings フォルダを指定）" }
$tiles = (Get-ChildItem -Path $LegacyBuildings -Recurse -Filter 'tile_*.json' -File | Measure-Object).Count
Write-Host "tile_*.json 実数: $tiles （期待 1,097）"

if ($Mode -in 'all', 'validate') {
  & node $tool --src $LegacyBuildings --validate
  $validateExit = $LASTEXITCODE
  if ($validateExit -ne 0) { Write-Warning '整合性に問題のある区があります。data\reports\mission40b-legacy-reuse\validate-external.json を確認。問題の無い区だけ変換するには -Mode convert。' }
  if ($Mode -eq 'all' -and $validateExit -ne 0) { throw '検証失敗のため変換を中止（-Mode convert で強制可）' }
}
if ($Mode -in 'all', 'inventory') { & node $tool --src $LegacyBuildings --inventory }
if ($Mode -in 'all', 'convert') {
  $OutRoot = [System.IO.Path]::GetFullPath($OutRoot)
  if ((Test-Path $OutRoot) -and (Get-ChildItem $OutRoot -Force | Select-Object -First 1)) { throw "出力先が空ではありません（上書きしません）: $OutRoot" }
  New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null
  & node $tool --src $LegacyBuildings --all-available --out-root $OutRoot
  $gb = [math]::Round(((Get-ChildItem $OutRoot -Recurse -File | Measure-Object Length -Sum).Sum) / 1GB, 2)
  Write-Host "変換完了: $OutRoot （$gb GB）。Git に add しないこと。"
}
