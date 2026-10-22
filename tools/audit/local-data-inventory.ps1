<#
  tools/audit/local-data-inventory.ps1
  [Mission 42] 自宅PC上の Live City 元データ（約75GB）の「読み取り専用」インベントリ生成。

  設計方針
  - 読み取り専用: 対象フォルダへは Get-ChildItem / Get-FileHash / 先頭バイト読み取りのみ。書き込み・移動・削除・
    ネットワーク通信は一切しない。出力は -OutDir（対象外フォルダ）だけに書く。
  - 秘密・個人情報そのものは出力しない: ファイル内容・マッチした文字列・ファイル名の生文字列は
    共有用出力（summary.json / files.csv）に含めない。含めるのは「該当件数」「リスク区分」だけ。
  - パスは共有用出力では SHA-256 の先頭12桁（pathId）に置換。実パスとの対応表は
    path-map.local.csv（ローカル専用、絶対にアップロード/コミットしない）にのみ書く。
  - 本スクリプトは何もアップロードしない。結果をGitHubへ渡すかどうかはユーザーが判断する。

  使い方（PowerShell 5.1 以降。管理者権限不要）
    pwsh -File tools\audit\local-data-inventory.ps1 -Root "D:\LiveCityData" -OutDir "C:\temp\lc-inventory"
    # 複数: -Root "D:\A","E:\B"   /  全ファイルをハッシュ: -HashMode All  /  ハッシュ無し: -HashMode None
    # 内容スキャン（小さなテキストのみ、件数だけ記録）: -ScanContent

  出力（-OutDir）
    summary.json         集計（共有可: 容量・拡張子別・出典候補別・リスク件数・重複グループ数）
    files.csv            1ファイル1行（共有可: pathId, 拡張子, サイズ, 更新日, sha256, 出典候補, リスクフラグ）
    path-map.local.csv   pathId ⇔ 実パス（ローカル専用・共有禁止）
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Root,
  [Parameter(Mandatory = $true)][string]$OutDir,
  # DuplicateCandidates: 同サイズが複数あるファイルのみハッシュ（既定・高速） / All: 全ファイル / None: ハッシュ無し
  [ValidateSet('DuplicateCandidates', 'All', 'None')][string]$HashMode = 'DuplicateCandidates',
  [switch]$ScanContent,
  [int]$ScanMaxKB = 1024
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# --- 安全確認: OutDir が Root の内側にないこと（対象フォルダを汚さない） ---
$rootFull = @($Root | ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\', '/') })
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outFull = [System.IO.Path]::GetFullPath($OutDir).TrimEnd('\', '/')
foreach ($r in $rootFull) {
  if ($outFull -eq $r -or $outFull.StartsWith($r + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutDir は Root の外側を指定してください（読み取り専用を保つため）: $outFull"
  }
}

function Get-ShortHash([string]$s) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $b = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s)) } finally { $sha.Dispose() }
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}

# --- 分類ルール（ファイル名/拡張子のパターンのみ。内容は見ない） ---
# 出典候補（あくまで候補。確定はユーザーの台帳照合で行う）
$sourceRules = @(
  @{ id = 'plateau';  pattern = '(?i)(plateau|citygml|_bldg_|_tran_|\.gml$|27100)' },
  @{ id = 'osm';      pattern = '(?i)(\.osm$|\.pbf$|overpass|openstreetmap|\bosm\b)' },
  @{ id = 'estat';    pattern = '(?i)(e-?stat|kokusei|census|tblT\d+|h27|r0?2.*(jinko|pop)|小地域|国勢調査)' },
  @{ id = 'google';   pattern = '(?i)(google|places|streetview|gmaps|maps\.googleapis)' },
  @{ id = 'gsi';      pattern = '(?i)(gsi|fgd|基盤地図|地理院|\.fgd$)' },
  @{ id = 'ipss';     pattern = '(?i)(ipss|社人研|将来推計)' },
  @{ id = 'osaka-city-open'; pattern = '(?i)(city\.osaka|大阪市.*オープン|opendata.*osaka)' }
)
# 秘密情報リスク（ファイル名/拡張子）
$secretNameRegex = '(?i)(^\.env(\..*)?$|id_rsa|id_ed25519|\.pem$|\.key$|\.pfx$|\.p12$|\.kdbx$|\.ppk$|credential|secret|token|api[-_]?key|service[-_]?account|cookies?(\.sqlite)?$|\.npmrc$|\.netrc$|gcloud|\.aws)'
# 個人情報リスク（ファイル名/拡張子）
$piiNameRegex = '(?i)(個人|住民|名簿|顧客|会員|氏名|電話|住所録|マイナンバー|personal|customer|contacts?|addressbook|\.pst$|\.ost$|\.eml$|\.vcf$|passport|license_scan)'
# 内容スキャン（-ScanContent 時のみ。件数だけ数え、一致文字列は保持しない）
$contentRules = @(
  @{ id = 'private-key-block'; regex = '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
  @{ id = 'aws-access-key';    regex = 'AKIA[0-9A-Z]{16}' },
  @{ id = 'google-api-key';    regex = 'AIza[0-9A-Za-z_\-]{35}' },
  @{ id = 'github-token';      regex = 'gh[pousr]_[A-Za-z0-9]{36,}' },
  @{ id = 'generic-secret-assignment'; regex = '(?i)(api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'']?[A-Za-z0-9_\-/+=]{12,}' },
  @{ id = 'email-address';     regex = '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}' },
  @{ id = 'jp-phone-number';   regex = '0\d{1,4}-\d{1,4}-\d{3,4}' }
)
$textExt = @('.json', '.csv', '.txt', '.md', '.js', '.mjs', '.cjs', '.ts', '.html', '.xml', '.ini', '.cfg', '.yml', '.yaml', '.toml', '.ps1', '.bat', '.env', '.geojson', '.tsv')

# --- 走査 ---
$rows = New-Object System.Collections.Generic.List[object]
$errors = 0
foreach ($r in $rootFull) {
  if (-not (Test-Path -LiteralPath $r)) { Write-Warning "Root が存在しません（スキップ）: $r"; continue }
  Get-ChildItem -LiteralPath $r -File -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable +enumErr | ForEach-Object {
    $f = $_
    $rel = $f.FullName.Substring($r.Length).TrimStart('\', '/')
    $ext = $f.Extension.ToLowerInvariant()
    if ($f.Name.ToLowerInvariant().EndsWith('.osm.pbf')) { $ext = '.osm.pbf' }

    $flags = New-Object System.Collections.Generic.List[string]
    if ($f.Name -match $secretNameRegex -or $rel -match $secretNameRegex) { $flags.Add('secret-name') }
    if ($f.Name -match $piiNameRegex -or $rel -match $piiNameRegex)       { $flags.Add('pii-name') }
    if ($f.Name -match '-DESKTOP-|\.tmp$|~\$') { $flags.Add('sync-conflict-or-temp') }
    if ($f.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $flags.Add('reparse-point') }

    $hints = @($sourceRules | Where-Object { $rel -match $_.pattern } | ForEach-Object { $_.id })
    if ($hints.Count -eq 0) { $hints = @('unknown') }

    if ($ScanContent -and ($textExt -contains $ext) -and $f.Length -le ($ScanMaxKB * 1KB) -and $f.Length -gt 0) {
      try {
        $text = [System.IO.File]::ReadAllText($f.FullName)
        foreach ($cr in $contentRules) {
          if ([regex]::IsMatch($text, $cr.regex)) { $flags.Add('content:' + $cr.id) }   # 一致文字列は保持しない
        }
        $text = $null
      } catch { $errors++ }
    }

    $rows.Add([pscustomobject]@{
      pathId = Get-ShortHash ($r + '|' + $rel)
      relPath = $rel
      ext = $ext
      sizeBytes = [int64]$f.Length
      lastWriteUtc = $f.LastWriteTimeUtc.ToString('yyyy-MM-dd')
      sha256 = ''
      sourceHint = ($hints -join '+')
      riskFlags = ($flags -join ';')
    })
  }
}
if (Test-Path variable:enumErr) { $errors += @($enumErr).Count }

# --- ハッシュ（読み取りのみ） ---
$toHash = switch ($HashMode) {
  'All' { $rows }
  'None' { @() }
  default {
    $dupSizes = $rows | Where-Object { $_.sizeBytes -gt 0 } | Group-Object sizeBytes | Where-Object { $_.Count -gt 1 } | ForEach-Object { [int64]$_.Name }
    $set = New-Object 'System.Collections.Generic.HashSet[int64]'
    foreach ($s in $dupSizes) { [void]$set.Add($s) }
    $rows | Where-Object { $set.Contains($_.sizeBytes) }
  }
}
$i = 0; $n = @($toHash).Count
foreach ($row in $toHash) {
  $i++
  if ($i % 200 -eq 0) { Write-Progress -Activity 'SHA-256' -Status "$i / $n" -PercentComplete ([int](100 * $i / [Math]::Max($n, 1))) }
  $fullPath = $null
  foreach ($r in $rootFull) { $cand = Join-Path $r $row.relPath; if (Test-Path -LiteralPath $cand) { $fullPath = $cand; break } }
  if ($fullPath) {
    try { $row.sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch { $errors++ }
  }
}

# --- 重複グループ（sha256 一致、サイズ>0） ---
$dupGroups = @($rows | Where-Object { $_.sha256 } | Group-Object sha256 | Where-Object { $_.Count -gt 1 })
$dupWasteBytes = [int64]0
foreach ($g in $dupGroups) { $dupWasteBytes += ([int64]($g.Group[0].sizeBytes) * ($g.Count - 1)) }

# --- 集計 ---
function ToMap($groups, $keyName) {
  $o = [ordered]@{}
  foreach ($g in ($groups | Sort-Object { ($_.Group | Measure-Object sizeBytes -Sum).Sum } -Descending)) {
    $o[$g.Name] = [ordered]@{ files = $g.Count; bytes = [int64](($g.Group | Measure-Object sizeBytes -Sum).Sum) }
  }
  return $o
}
$byExt = ToMap ($rows | Group-Object ext) 'ext'
$byHint = ToMap ($rows | Group-Object sourceHint) 'sourceHint'
$flagCounts = [ordered]@{}
foreach ($row in $rows) { foreach ($fl in ($row.riskFlags -split ';' | Where-Object { $_ })) { if ($flagCounts.Contains($fl)) { $flagCounts[$fl]++ } else { $flagCounts[$fl] = 1 } } }
$totalBytes = [int64](($rows | Measure-Object sizeBytes -Sum).Sum)
$over100MB = @($rows | Where-Object { $_.sizeBytes -gt 100MB }).Count
$over2GB = @($rows | Where-Object { $_.sizeBytes -gt 2GB }).Count

$summary = [ordered]@{
  schema = 'livecity-local-inventory/v1'
  mission = 42
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  rootCount = $rootFull.Count
  hashMode = $HashMode
  contentScan = [bool]$ScanContent
  totals = [ordered]@{ files = $rows.Count; bytes = $totalBytes; gib = [Math]::Round($totalBytes / 1GB, 2); filesOver100MB = $over100MB; filesOver2GB = $over2GB }
  byExtension = $byExt
  bySourceHint = $byHint
  riskFlagCounts = $flagCounts
  duplicates = [ordered]@{ groups = $dupGroups.Count; wastedBytes = $dupWasteBytes; wastedGib = [Math]::Round($dupWasteBytes / 1GB, 2) }
  enumerationErrors = $errors
  notes = @('パス・ファイル名・内容は含まない。pathId は path-map.local.csv でのみ実パスに戻せる。', 'sourceHint はパターンに基づく候補であり、出典・ライセンスの確定ではない。')
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutDir 'summary.json') -Encoding UTF8

$rows | Select-Object pathId, ext, sizeBytes, lastWriteUtc, sha256, sourceHint, riskFlags |
  Export-Csv -LiteralPath (Join-Path $OutDir 'files.csv') -NoTypeInformation -Encoding UTF8
$rows | Select-Object pathId, relPath | Export-Csv -LiteralPath (Join-Path $OutDir 'path-map.local.csv') -NoTypeInformation -Encoding UTF8

Write-Host "完了: $($rows.Count) files / $([Math]::Round($totalBytes / 1GB, 2)) GiB / 重複グループ $($dupGroups.Count)"
Write-Host "共有可: summary.json, files.csv   共有禁止: path-map.local.csv"
