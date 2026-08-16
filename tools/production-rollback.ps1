# production-rollback.ps1 v2 — cutover前の状態へ復元
# 実行例:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\production-rollback.ps1 `
#     -ProjectRoot C:\Users\you\OneDrive\livecity `
#     -BackupDir  C:\Users\you\OneDrive\livecity\temp\prod-znegate\backup-20260726-XXXXXX `
#     -IUnderstandRollback -ConfirmOneDrivePaused
# 変更せず照合のみ: -Verify
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [Parameter(Mandatory=$true)][string]$BackupDir,
  [int]$HttpPort = 8080,
  [switch]$IUnderstandRollback,
  [switch]$ConfirmOneDrivePaused,
  [switch]$Verify
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Fail([string]$msg){ Write-Error $msg; exit 1 }
function ShaOf([string]$p){ (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$BackupDir   = (Resolve-Path -LiteralPath $BackupDir).Path
$LiveHtml = Join-Path $ProjectRoot 'public\osaka_3d_buildings.html'
$BakHtml  = Join-Path $BackupDir 'osaka_3d_buildings.html.bak'
$BeforeLedger = Join-Path $BackupDir 'SHA256_PUBLIC_BEFORE.txt'   # 指定BackupDir内の台帳のみ使用
$ArchiveLedger = Join-Path $BackupDir 'SHA256_BACKUP_ARCHIVE.txt'
$ScopeFile = Join-Path $BackupDir 'LEDGER_SCOPE.json'
foreach ($p in @($LiveHtml,$BakHtml,$BeforeLedger,$ArchiveLedger,$ScopeFile)) { if (-not (Test-Path -LiteralPath $p)) { Fail "必須ファイルが無い: $p" } }

# ── バックアップHTML自体のハッシュを台帳と照合（壊れたバックアップで復元しない）──
$archLine = (Get-Content -LiteralPath $ArchiveLedger | Where-Object { $_ -match [regex]::Escape($BakHtml) } | Select-Object -First 1)
if (-not $archLine) { Fail "SHA256_BACKUP_ARCHIVE.txt に .bak の記録が無い" }
$expBak = ($archLine -split '\s+')[0].ToLower()
if ((ShaOf $BakHtml) -ne $expBak) { Fail "バックアップHTMLのハッシュが台帳と不一致（バックアップ破損の疑い）。復元を中止します。" }

# ── 現在の公開状態を BEFORE台帳と照合する関数（LEDGER_SCOPE.json の範囲で再計算）──
$scope = Get-Content -LiteralPath $ScopeFile -Raw | ConvertFrom-Json
function CurrentLedger {
  $files = @($scope.liveHtml)
  foreach ($d in $scope.dirs) { $files += (Get-ChildItem -LiteralPath $d -Recurse -File | ForEach-Object FullName) }
  $files | ForEach-Object { "{0}  {1}" -f (ShaOf $_), $_ } | Sort-Object
}
if ($Verify) {
  $diff = Compare-Object (Get-Content -LiteralPath $BeforeLedger) (CurrentLedger)
  if ($diff) { Write-Host "BEFORE台帳との差分:"; $diff | Format-Table | Out-String | Write-Host; exit 1 }
  Write-Host "公開ファイルは BEFORE台帳と完全一致（復元不要）"; exit 0
}

# ── HTTPサーバー / OneDrive（cutoverと同じ基準。強制終了しない）──
$conns = Get-NetTCPConnection -LocalPort $HttpPort -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  foreach ($c in $conns) { $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; Write-Host ("  ポート{0}: PID={1} 名称={2}" -f $HttpPort,$c.OwningProcess,$proc.ProcessName) }
  Fail "ポート$HttpPort でHTTPサーバーが稼働中。手動で終了してから再実行してください。"
}
$od = Get-Process -Name OneDrive -ErrorAction SilentlyContinue
if ($od -and -not $ConfirmOneDrivePaused) { Fail "OneDrive稼働中。同期を一時停止し -ConfirmOneDrivePaused を付けて再実行してください。" }
if (-not $IUnderstandRollback) { Fail "-IUnderstandRollback が指定されていません。" }

# ── 不良HTMLを public ではなく BackupDir 内へ退避 ──
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BadSaved = Join-Path $BackupDir ("osaka_3d_buildings.html.bad-" + $stamp)
Copy-Item -LiteralPath $LiveHtml -Destination $BadSaved
Write-Host "現在のHTMLを退避: $BadSaved (sha256=$(ShaOf $BadSaved))"

# ── 復元（File.Replace。一時ファイルは finally で必ず public から除去）──
$Restore = "$LiveHtml.restore"
try {
  Copy-Item -LiteralPath $BakHtml -Destination $Restore
  [System.IO.File]::Replace($Restore, $LiveHtml, (Join-Path $BackupDir ("osaka_3d_buildings.html.pre-rollback-" + $stamp + ".bak")))
  $after = ShaOf $LiveHtml
  if ($after -ne $expBak) { Fail "復元後ハッシュがバックアップと不一致: $after" }
  # 復元後、公開ファイル一覧+SHAが BEFORE台帳と完全一致することを確認
  $diff = Compare-Object (Get-Content -LiteralPath $BeforeLedger) (CurrentLedger)
  if ($diff) { Write-Host "警告: BEFORE台帳と不一致の項目があります:"; $diff | Format-Table | Out-String | Write-Host; exit 1 }
  Write-Host "ロールバック完了: 公開ファイルは BEFORE台帳と完全一致 (html sha256=$after)"
} finally {
  foreach ($tmp in @($Restore, "$LiveHtml.incoming")) {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
  }
}

