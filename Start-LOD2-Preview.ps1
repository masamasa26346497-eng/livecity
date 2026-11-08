# Mission 162: Windows PowerShell 一発起動。どのフォルダから実行しても、このファイルの場所をリポジトリルートとして使う。
#   PowerShell で:  .\Start-LOD2-Preview.ps1            (実行ポリシーで止まる場合: powershell -ExecutionPolicy Bypass -File .\Start-LOD2-Preview.ps1)
#   オプション:      -NoOpen / -Port 8153 / -ExtRoot "C:\path\ext-3dtiles" / -CheckOnly
# サーバ起動後はこのウィンドウがブロックします(正常)。Ctrl+C で停止。何も削除/上書きしません。
param([int]$Port = 8152, [switch]$NoOpen, [switch]$CheckOnly, [string]$ExtRoot = "")
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host "Node.js 18 以上が必要です。https://nodejs.org/ から入れて、PowerShell を開き直してください。" -ForegroundColor Red; exit 1 }
$launch = Join-Path $root "tools\lod2\lod2-launch.mjs"
if (-not (Test-Path $launch)) {
  Write-Host "このフォルダ($root)には LOD2 のコードがありません(PR24 など別ブランチの可能性)。" -ForegroundColor Red
  Write-Host "tools\lod2\README-LAUNCH.md の「別ブランチで使っている場合」の手順で mission152-lod2-parallel を別フォルダに取得してください。" -ForegroundColor Yellow
  exit 1
}
$a = @($launch, "--port", "$Port")
if ($NoOpen) { $a += "--no-open" }
if ($CheckOnly) { $a += "--check-only" }
if ($ExtRoot) { $a += @("--ext-root", $ExtRoot) }
& node @a
exit $LASTEXITCODE
