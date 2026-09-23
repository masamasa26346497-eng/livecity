<#
.SYNOPSIS
  Live City の City Mode 状態を PowerShell から取得する（DevTools Console を手入力しない）。

.DESCRIPTION
  Chrome/Edge を --remote-debugging-port で起動（または既存を再利用）し、Chrome DevTools Protocol
  経由で対象タブ上の JavaScript 式（既定 __CITY_MODE_DEBUG__()）を評価して結果を JSON 表示する。

  - 外部 npm / モジュール不要。System.Net.WebSockets.ClientWebSocket（.NET Framework 標準）のみ使用。
  - Windows PowerShell 5.1 で動作。
  - protected HTML（fullward-v3.html / production）には一切触れない。

.PARAMETER Port
  リモートデバッグポート（既定 9222）。

.PARAMETER Url
  開く／対象にするページ URL（既定 http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html）。

.PARAMETER Expression
  評価する JS 式（既定 __CITY_MODE_DEBUG__()）。任意の式を渡せる（例: __CITY_CAMERA_DEBUG__()）。

.PARAMETER LaunchChrome
  Chrome/Edge を新しい分離プロファイルで起動する。ポートが既に応答していれば再利用する。

.PARAMETER EnterCityMode
  評価の前に CityModeManager.enter() を実行し、WaitAfterEnterSec 秒待ってから式を評価する。

.PARAMETER WaitAfterEnterSec
  EnterCityMode 実行後の待機秒数（既定 6）。

.PARAMETER StartServer
  public/ を http://localhost:8000 で配信する簡易サーバを起動する（python が必要）。

.PARAMETER Raw
  ページが返した JSON 文字列をそのまま出力する（整形しない）。

.PARAMETER Watch
  指定秒間隔で繰り返し評価する（Ctrl+C で終了）。

.PARAMETER TimeoutSec
  CDP 応答待ちのタイムアウト秒（既定 20）。

.PARAMETER ChromePath
  chrome.exe / msedge.exe のパスを明示指定（未指定なら自動検出）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\debug\check-city-mode.ps1 -LaunchChrome -EnterCityMode
#>
[CmdletBinding()]
param(
  [int]$Port = 9222,
  [string]$Url = 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html',
  [string]$Expression = '__CITY_MODE_DEBUG__()',
  [switch]$LaunchChrome,
  [switch]$EnterCityMode,
  [int]$WaitAfterEnterSec = 6,
  [switch]$StartServer,
  [switch]$Raw,
  [int]$Watch = 0,
  [int]$TimeoutSec = 20,
  [string]$ChromePath
)

$ErrorActionPreference = 'Stop'
# System.Net.WebSockets.ClientWebSocket は Windows 8+ の .NET Framework 標準（追加アセンブリ不要）。

function Find-Browser {
  if ($ChromePath -and (Test-Path $ChromePath)) { return $ChromePath }
  $cands = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LocalAppData 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  throw 'Chrome / Edge が見つかりません。-ChromePath でパスを指定してください。'
}

function Test-DevtoolsUp {
  param([int]$P)
  try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$P/json/version" -TimeoutSec 3
    return [bool]$v
  } catch { return $false }
}

function Wait-DevtoolsUp {
  param([int]$P, [int]$Sec = 25)
  $deadline = (Get-Date).AddSeconds($Sec)
  while ((Get-Date) -lt $deadline) {
    if (Test-DevtoolsUp -P $P) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Get-PageTarget {
  param([int]$P, [string]$TargetUrl)
  $list = Invoke-RestMethod -Uri "http://127.0.0.1:$P/json/list" -TimeoutSec 5
  $pages = @($list | Where-Object { $_.type -eq 'page' })
  # URL の path 部分でゆるく一致（クエリ/ハッシュ差は無視）
  $needle = 'osaka_3d_buildings'
  try { $needle = ([Uri]$TargetUrl).AbsolutePath } catch {}
  $t = $pages | Where-Object { $_.url -like "*$needle*" } | Select-Object -First 1
  if ($t) { return $t }
  # 見つからなければ新規タブを作る（Chrome 111+ は PUT、旧版は GET）
  $enc = [Uri]::EscapeDataString($TargetUrl)
  foreach ($m in @('Put', 'Get')) {
    try {
      $t = Invoke-RestMethod -Method $m -Uri "http://127.0.0.1:$P/json/new?$enc" -TimeoutSec 5
      if ($t -and $t.webSocketDebuggerUrl) {
        Start-Sleep -Milliseconds 1200  # 読み込み待ち
        return $t
      }
    } catch {}
  }
  if ($pages.Count -gt 0) {
    Write-Warning "'$needle' を含むタブが無いため、最初の page タブを対象にします: $($pages[0].url)"
    return $pages[0]
  }
  throw "対象タブが見つからず、新規タブも作成できませんでした。"
}

function Invoke-Cdp {
  param([string]$WsUrl, [string]$Method, [hashtable]$CdpParams, [int]$Timeout = 20)
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  try {
    $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(15)
    [void]$ws.ConnectAsync([Uri]$WsUrl, $ct).GetAwaiter().GetResult()
    $id = Get-Random -Minimum 1 -Maximum 2000000000
    $msg = @{ id = $id; method = $Method }
    if ($CdpParams) { $msg['params'] = $CdpParams }
    $payload = $msg | ConvertTo-Json -Depth 12 -Compress
    $sendBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $sendSeg = New-Object 'System.ArraySegment[byte]' -ArgumentList (,$sendBytes)
    [void]$ws.SendAsync($sendSeg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()

    $deadline = (Get-Date).AddSeconds($Timeout)
    $buf = New-Object byte[] 131072
    while ((Get-Date) -lt $deadline) {
      $sb = New-Object System.Text.StringBuilder
      do {
        $recvSeg = New-Object 'System.ArraySegment[byte]' -ArgumentList (,$buf)
        $r = $ws.ReceiveAsync($recvSeg, $ct).GetAwaiter().GetResult()
        if ($null -eq $r) { break }
        if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
          throw "WebSocket closed by browser: $($r.CloseStatusDescription)"
        }
        [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
      } while (-not $r.EndOfMessage)
      $frame = $sb.ToString()
      $obj = $null
      try { $obj = $frame | ConvertFrom-Json } catch { continue }
      if ($obj.id -eq $id) { return $obj }   # 自分の応答。イベント通知はスキップ
    }
    throw "CDP 応答タイムアウト ($Timeout 秒): $Method"
  }
  finally {
    try {
      if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        [void]$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', $ct).GetAwaiter().GetResult()
      }
    } catch {}
    $ws.Dispose()
  }
}

function Invoke-JsExpression {
  param([string]$WsUrl, [string]$Js, [int]$Timeout = 20)
  # 例外・未定義でもクリーンに JSON 化されるようラップ
  $wrapped = "JSON.stringify((function(){try{return ($Js);}catch(e){return {__error:String(e && e.stack || e)};}})())"
  $resp = Invoke-Cdp -WsUrl $WsUrl -Method 'Runtime.evaluate' -CdpParams @{
    expression    = $wrapped
    returnByValue = $true
    awaitPromise  = $true
  } -Timeout $Timeout
  if ($resp.error) { throw "CDP error: $($resp.error.message)" }
  $rr = $resp.result
  if ($rr.exceptionDetails) {
    $ex = $rr.exceptionDetails
    $txt = if ($ex.exception -and $ex.exception.description) { $ex.exception.description } else { $ex.text }
    throw "JS 実行例外: $txt"
  }
  return [string]$rr.result.value
}

# ── サーバ（任意） ──
if ($StartServer) {
  $pub = Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'public'
  $py = (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $py) { $py = (Get-Command py -ErrorAction SilentlyContinue) }
  if ($py -and (Test-Path $pub)) {
    $portFromUrl = 8000
    try { $portFromUrl = ([Uri]$Url).Port } catch {}
    Write-Host "簡易サーバ起動: $($py.Source) -m http.server $portFromUrl (cwd=$pub)" -ForegroundColor DarkGray
    Start-Process -FilePath $py.Source -ArgumentList @('-m', 'http.server', "$portFromUrl") -WorkingDirectory $pub -WindowStyle Minimized
    Start-Sleep -Seconds 1
  } else {
    Write-Warning "python が無いため簡易サーバを起動できません。別途 `python -m http.server 8000` を public/ で実行してください。"
  }
}

# ── ブラウザ起動 / 再利用 ──
if ($LaunchChrome) {
  if (Test-DevtoolsUp -P $Port) {
    Write-Host "ポート $Port は既に応答中。既存のデバッグセッションを再利用します。" -ForegroundColor DarkGray
  } else {
    $browser = Find-Browser
    $profileDir = Join-Path $env:TEMP 'livecity-cdp-profile'
    $null = New-Item -ItemType Directory -Path $profileDir -Force
    $chromeArgs = @(
      "--remote-debugging-port=$Port",
      "--user-data-dir=`"$profileDir`"",
      '--no-first-run', '--no-default-browser-check',
      '--remote-allow-origins=*',
      '--new-window',
      $Url
    )
    Write-Host "起動: $browser --remote-debugging-port=$Port" -ForegroundColor DarkGray
    Start-Process -FilePath $browser -ArgumentList $chromeArgs | Out-Null
    if (-not (Wait-DevtoolsUp -P $Port -Sec 25)) {
      throw "DevTools エンドポイント (http://127.0.0.1:$Port) が起動しませんでした。"
    }
  }
} else {
  if (-not (Test-DevtoolsUp -P $Port)) {
    throw "http://127.0.0.1:$Port に DevTools がありません。-LaunchChrome を付けるか、Chrome を --remote-debugging-port=$Port で起動してください。"
  }
}

# ── 対象タブ ──
$target = Get-PageTarget -P $Port -TargetUrl $Url
$wsUrl = $target.webSocketDebuggerUrl
if (-not $wsUrl) { throw "対象タブに webSocketDebuggerUrl がありません（DevTools が既に接続中の可能性）。そのタブの DevTools を閉じてください。" }
Write-Host "対象タブ: $($target.title)  [$($target.url)]" -ForegroundColor DarkGray

function Run-Once {
  if ($EnterCityMode) {
    Write-Host "CityModeManager.enter() を実行 → $WaitAfterEnterSec 秒待機..." -ForegroundColor DarkGray
    $enterJs = "(typeof CityModeManager!=='undefined' && CityModeManager.enter) ? (CityModeManager.enter(), 'entered') : 'CityModeManager 未定義'"
    $er = Invoke-JsExpression -WsUrl $wsUrl -Js $enterJs -Timeout $TimeoutSec
    Write-Host "  → $er" -ForegroundColor DarkGray
    Start-Sleep -Seconds $WaitAfterEnterSec
  }

  $jsonStr = Invoke-JsExpression -WsUrl $wsUrl -Js $Expression -Timeout $TimeoutSec
  if (-not $jsonStr -or $jsonStr -eq 'null' -or $jsonStr -eq 'undefined') {
    Write-Warning "式 '$Expression' が null/undefined を返しました（関数が未定義の可能性。ページをハードリロードして再実行してください）。"
    return
  }

  if ($Raw) {
    $jsonStr
    return
  }

  $obj = $jsonStr | ConvertFrom-Json
  if ($obj.__error) {
    Write-Warning "ページ側で例外: $($obj.__error)"
    return
  }

  Write-Host ""
  Write-Host "===== $Expression =====" -ForegroundColor Cyan
  $obj | ConvertTo-Json -Depth 20

  # City Mode 用の要点サマリ（該当キーがある場合のみ）
  if ($null -ne $obj.cityModeActive) {
    $ready = if ($obj.cityBuildingLOD) { $obj.cityBuildingLOD.wardsReady } else { '?' }
    $tiles = 0
    if ($obj.cityTileLayer) { foreach ($k in 'roads','waterways','parks','railways') { if ($obj.cityTileLayer.$k) { $tiles += [int]$obj.cityTileLayer.$k.loadedTiles } } }
    Write-Host ""
    Write-Host "----- 要点 -----" -ForegroundColor Cyan
    Write-Host ("  cityModeActive        : {0}" -f $obj.cityModeActive)
    Write-Host ("  wardDefsCount         : {0}" -f $obj.wardDefsCount)
    Write-Host ("  wardPolyCacheCount    : {0}  (期待 24)" -f $obj.wardPolyCacheCount)
    Write-Host ("  CityBuildingLOD ready : {0} / {1}" -f $ready, $obj.wardDefsCount)
    Write-Host ("  enabledBuildingDatasets(count): {0}" -f (@($obj.enabledBuildingDatasets).Count))
    Write-Host ("  cityTileLayer loadedTiles(合計): {0}" -f $tiles)
    Write-Host ("  cameraRadius          : {0}" -f $obj.cameraRadius)
    Write-Host ("  rendererDrawCalls     : {0}" -f $obj.rendererDrawCalls)
    if ("$($obj.cityModeActive)" -eq 'True' -and [int]$ready -ge ($obj.wardDefsCount - 2)) {
      Write-Host "  => City Mode は正常に24区をロードしています。" -ForegroundColor Green
    } elseif ("$($obj.cityModeActive)" -ne 'True') {
      Write-Host "  => まだ City Mode に入っていません。-EnterCityMode を付けて再実行してください。" -ForegroundColor Yellow
    } else {
      Write-Host "  => City Mode 中。まだロード進行中の可能性（数秒後に再実行）。" -ForegroundColor Yellow
    }
  }
}

if ($Watch -gt 0) {
  Write-Host "Watch モード: $Watch 秒間隔で再取得（Ctrl+C で終了）" -ForegroundColor DarkGray
  $EnterCityMode = $false  # 2回目以降は enter しない
  Run-Once
  while ($true) {
    Start-Sleep -Seconds $Watch
    Write-Host ("`n--- {0} ---" -f (Get-Date -Format 'HH:mm:ss')) -ForegroundColor DarkGray
    Run-Once
  }
} else {
  Run-Once
}
