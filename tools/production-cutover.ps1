# production-cutover.ps1 v2 — 本番HTML切替（Windows / OneDrive配下）
# 実行例:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\production-cutover.ps1 `
#     -ProjectRoot C:\Users\you\OneDrive\livecity -ReleaseId znorth-neg-v1 -Dataset osaka-higashisumiyoshi `
#     -TempReleaseRoot C:\Users\you\OneDrive\livecity\temp\prod-znegate\release\znorth-neg-v1 `
#     -IUnderstandCutover -ConfirmOneDrivePaused
# まず -WhatIfOnly を付けて確認すること。
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [Parameter(Mandatory=$true)][string]$ReleaseId,
  [Parameter(Mandatory=$true)][string]$Dataset,
  [Parameter(Mandatory=$true)][string]$TempReleaseRoot,
  [string]$BackupDir = "",
  [int]$HttpPort = 8080,
  [switch]$IUnderstandCutover,
  [switch]$ConfirmOneDrivePaused,
  [switch]$WhatIfOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Fail([string]$msg){ Write-Error $msg; exit 1 }

$ProjectRoot     = (Resolve-Path -LiteralPath $ProjectRoot).Path
$TempReleaseRoot = (Resolve-Path -LiteralPath $TempReleaseRoot).Path
$LiveHtml   = Join-Path $ProjectRoot 'public\osaka_3d_buildings.html'
$NewHtml    = Join-Path $TempReleaseRoot 'osaka_3d_buildings.html'
$PubBRel    = Join-Path $ProjectRoot ("public\data\buildings\releases\" + $ReleaseId)
$PubORel    = Join-Path $ProjectRoot ("public\data\overlays\releases\" + $ReleaseId)
if ($BackupDir -eq "") { $BackupDir = Join-Path $ProjectRoot ("temp\prod-znegate\backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
foreach ($p in @($LiveHtml,$NewHtml,$PubBRel,$PubORel)) { if (-not (Test-Path -LiteralPath $p)) { Fail "必須パスが無い: $p" } }

# ── GATE 1: RELEASE_READY.json と実ファイルハッシュ（Nodeゲート。不一致は即停止）──
& node (Join-Path $ProjectRoot 'tools\check-release-ready.cjs') --release-root $TempReleaseRoot
if ($LASTEXITCODE -ne 0) { Fail "cutover-gate NG: RELEASE_READY が無い/ハッシュ不一致。切替を中止します。" }
$Ready = Get-Content -LiteralPath (Join-Path $TempReleaseRoot 'RELEASE_READY.json') -Raw | ConvertFrom-Json
if ($Ready.releaseId -ne $ReleaseId) { Fail "READYのreleaseId($($Ready.releaseId))と指定($ReleaseId)が不一致" }
$BuildId = [string]$Ready.buildId

# ── GATE 2: public releases コピーが READY のハッシュと一致 ──
function ShaOf([string]$p){ (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
$pairs = @(
  @{ pub = (Join-Path $PubBRel 'manifest.json');                       key = 'buildings/manifest.json' },
  @{ pub = (Join-Path $PubBRel (Join-Path $Dataset 'manifest.json'));  key = "buildings/$Dataset/manifest.json" },
  @{ pub = (Join-Path $PubORel ($Dataset + '.json'));                  key = "overlays/$Dataset.json" }
)
foreach ($pr in $pairs) {
  if (-not (Test-Path -LiteralPath $pr.pub)) { Fail "public releasesにコピーが無い: $($pr.pub)" }
  $expect = $Ready.files.($pr.key)
  if ((ShaOf $pr.pub) -ne $expect.ToLower()) { Fail "public側ハッシュ不一致: $($pr.pub)（READYと不一致。コピーし直してください）" }
}
$tileCount = (Get-ChildItem -LiteralPath (Join-Path $PubBRel $Dataset) -Filter 'tile_*.json' | Measure-Object).Count
if ($tileCount -ne [int]$Ready.tileCount) { Fail "publicタイル数($tileCount)がREADY($($Ready.tileCount))と不一致" }

# ── GATE 2b: 全タイル本体のdigest再計算（tileCount一致だけでは許可しない）──
# compute-tiles-digest.cjs は verify-production-release.cjs / check-release-ready.cjs と
# 完全に同一のNodeロジックでdigestを算出する（PowerShell側での再実装によるアルゴリズム相違を排除するため、
# 計算自体をNodeへ委譲している）。1タイルの内容改ざん・差替（同一tileCountでも内容が異なる場合）を検出する。
$tilesDirForDigest = Join-Path $PubBRel $Dataset
$digestJson = & node (Join-Path $ProjectRoot 'tools\compute-tiles-digest.cjs') --tiles-dir $tilesDirForDigest --dataset $Dataset --json
if ($LASTEXITCODE -ne 0) { Fail "GATE2b: compute-tiles-digest.cjs の実行に失敗しました" }
$Digest = $digestJson | ConvertFrom-Json
if ($Digest.count -ne [int]$Ready.tileFiles.Count) { Fail "GATE2b: タイル数不一致 実測=$($Digest.count) / READY記録=$($Ready.tileFiles.Count)" }
if ($Digest.tilesDigest -ne $Ready.tilesDigest) { Fail "GATE2b: タイルdigest不一致（READY.tilesDigestと不一致。1件以上のタイル本体が改ざん/差替/欠落/余剰の可能性）" }

# ── GATE 3: 新HTMLの積極的な内容確認 ──
$nh = Get-Content -LiteralPath $NewHtml -Raw
if ((ShaOf $NewHtml) -ne $Ready.files.'osaka_3d_buildings.html'.ToLower()) { Fail "新HTMLのハッシュがREADYと不一致" }
if ($nh -notmatch [regex]::Escape("LIVE_CITY_BUILD_ID = '$BuildId'")) { Fail "新HTMLに新BUILD_ID('$BuildId')の文字列一致が無い" }
if ($nh -match [regex]::Escape("LIVE_CITY_BUILD_ID = 'multiward-overlay-v1'")) { Fail "新HTMLに旧BUILD_IDが残っている" }
if ($nh -notmatch [regex]::Escape("data/buildings/releases/$ReleaseId")) { Fail "新HTMLがbuildings releaseパスを参照していない" }
if ($nh -notmatch [regex]::Escape("data/overlays/releases/$ReleaseId"))  { Fail "新HTMLがoverlays releaseパスを参照していない" }
if ($nh -notmatch [regex]::Escape('EXPECTED_COORDINATE_CONVENTION = "znorth-neg-v1"')) { Fail "新HTMLに座標規約ガードが無い" }

# ── GATE 4: HTTPサーバー検出（強制終了は絶対にしない。検出したら停止してユーザーに終了を依頼）──
$conns = Get-NetTCPConnection -LocalPort $HttpPort -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    Write-Host ("  ポート{0}をLISTEN中: PID={1} 名称={2}" -f $HttpPort, $c.OwningProcess, ($proc.ProcessName))
  }
  Fail "ポート$HttpPort でHTTPサーバーが稼働中です。対象か判別できないため停止します。手動で終了してから再実行してください（本スクリプトはプロセスを強制終了しません）。"
}

# ── GATE 5: OneDrive（一時停止の要求送信では成功扱いしない。ユーザー確認スイッチ必須）──
$od = Get-Process -Name OneDrive -ErrorAction SilentlyContinue
if ($od -and -not $ConfirmOneDrivePaused) {
  Fail "OneDriveが稼働中です。タスクトレイから「同期の一時停止」を行い、-ConfirmOneDrivePaused を付けて再実行してください（要求送信のみでは成功と見なしません）。"
}

# ── GATE 6: ユーザー確認スイッチ ──
Write-Host "切替内容:"
Write-Host "  live   : $LiveHtml"
Write-Host "  new    : $NewHtml (BUILD_ID=$BuildId, buildings=$($Ready.buildings), tiles=$($Ready.tileCount))"
Write-Host "  backup : $BackupDir"
if ($WhatIfOnly) { Write-Host "-WhatIfOnly のため変更せず終了（全ゲート通過）"; exit 0 }
if (-not $IUnderstandCutover) { Fail "-IUnderstandCutover が指定されていません。内容を確認のうえ付与して再実行してください。" }

# ── バックアップ + BEFORE台帳（BackupDir内へ）──
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$scope = @($LiveHtml) + (Get-ChildItem -LiteralPath $PubBRel -Recurse -File | ForEach-Object FullName) + (Get-ChildItem -LiteralPath $PubORel -Recurse -File | ForEach-Object FullName)
@{ liveHtml=$LiveHtml; dirs=@($PubBRel,$PubORel) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BackupDir 'LEDGER_SCOPE.json') -Encoding UTF8
$scope | ForEach-Object { "{0}  {1}" -f (ShaOf $_), $_ } | Sort-Object | Set-Content -LiteralPath (Join-Path $BackupDir 'SHA256_PUBLIC_BEFORE.txt') -Encoding UTF8
$BakHtml = Join-Path $BackupDir 'osaka_3d_buildings.html.bak'
Copy-Item -LiteralPath $LiveHtml -Destination $BakHtml
@("{0}  {1}" -f (ShaOf $BakHtml), $BakHtml) | Set-Content -LiteralPath (Join-Path $BackupDir 'SHA256_BACKUP_ARCHIVE.txt') -Encoding UTF8

# ── 置換（Move-Item -Force ではなく [System.IO.File]::Replace）──
$Incoming = "$LiveHtml.incoming"
try {
  Copy-Item -LiteralPath $NewHtml -Destination $Incoming -Force:$false
  [System.IO.File]::Replace($Incoming, $LiveHtml, (Join-Path $BackupDir 'osaka_3d_buildings.html.replaced.bak'))
  $after = ShaOf $LiveHtml
  if ($after -ne $Ready.files.'osaka_3d_buildings.html'.ToLower()) { throw "置換後ハッシュがREADYと不一致（自動復旧します）" }
  $scope | ForEach-Object { "{0}  {1}" -f (ShaOf $_), $_ } | Sort-Object | Set-Content -LiteralPath (Join-Path $BackupDir 'SHA256_PUBLIC_AFTER.txt') -Encoding UTF8
  Write-Host "切替完了: $LiveHtml (sha256=$after)"
  Write-Host "ロールバック: powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\production-rollback.ps1 -ProjectRoot `"$ProjectRoot`" -BackupDir `"$BackupDir`" -IUnderstandRollback"
} catch {
  Write-Warning "切替に失敗: $($_.Exception.Message) — バックアップから復旧を試みます"
  try {
    if (Test-Path -LiteralPath $BakHtml) {
      $Restore = "$LiveHtml.restore"
      Copy-Item -LiteralPath $BakHtml -Destination $Restore -Force
      [System.IO.File]::Replace($Restore, $LiveHtml, (Join-Path $BackupDir 'osaka_3d_buildings.html.failed-swap.bak'))
      Write-Host "旧HTMLへ復旧済み"
    }
  } catch { Write-Error "自動復旧にも失敗: $($_.Exception.Message)。production-rollback.ps1 を実行してください。" }
  exit 1
} finally {
  foreach ($tmp in @($Incoming, "$LiveHtml.restore")) {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
  }
}

