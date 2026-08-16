$ErrorActionPreference = "Stop"

try {
    $projectRoot = (Get-Location).Path

    $downloadsRaw = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")."{374DE290-123F-4565-9164-39C4925E467B}"
    $downloads = [Environment]::ExpandEnvironmentVariables($downloadsRaw)

    if (-not (Test-Path -LiteralPath $downloads)) {
        $downloads = Join-Path $HOME "Downloads"
    }

    if (-not (Test-Path -LiteralPath $downloads)) {
        throw "ダウンロードフォルダが見つかりません: $downloads"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem

    Write-Host "ダウンロードフォルダ: $downloads"
    Write-Host "ステージングHTMLを含むZIPを探しています..."

    $zipFiles = Get-ChildItem -LiteralPath $downloads -File -Filter "*.zip" |
        Sort-Object LastWriteTime -Descending

    $selectedZip = $null

    foreach ($zipFile in $zipFiles) {
        $archive = $null

        try {
            $archive = [System.IO.Compression.ZipFile]::OpenRead($zipFile.FullName)

            $found = $archive.Entries |
                Where-Object {
                    $path = $_.FullName.Replace("\", "/")
                    $path -match "(^|/)staging/osaka_3d_buildings\.html$"
                } |
                Select-Object -First 1

            if ($found) {
                $selectedZip = $zipFile
                break
            }
        }
        catch {
            Write-Host "読み飛ばし: $($zipFile.Name)"
        }
        finally {
            if ($archive) {
                $archive.Dispose()
            }
        }
    }

    if (-not $selectedZip) {
        throw "staging/osaka_3d_buildings.htmlを含むZIPが見つかりません。"
    }

    Write-Host ""
    Write-Host "対象ZIP: $($selectedZip.FullName)" -ForegroundColor Cyan

    $tempRoot = Join-Path $projectRoot "temp"
    $extractRoot = Join-Path $tempRoot "_znegate_zip_extract"
    $targetRoot = Join-Path $tempRoot "znegate-prototype"

    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

    if (Test-Path -LiteralPath $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }

    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null

    Expand-Archive `
        -LiteralPath $selectedZip.FullName `
        -DestinationPath $extractRoot `
        -Force

    $stagingHtml = Get-ChildItem `
        -LiteralPath $extractRoot `
        -Recurse `
        -File `
        -Filter "osaka_3d_buildings.html" |
        Where-Object {
            $_.FullName -match "[\\/]staging[\\/]osaka_3d_buildings\.html$"
        } |
        Select-Object -First 1

    if (-not $stagingHtml) {
        throw "ZIP展開後にステージングHTMLが見つかりません。"
    }

    $sourceStaging = $stagingHtml.Directory.FullName
    $sourcePrototype = Split-Path $sourceStaging -Parent

    if (-not (Test-Path -LiteralPath $sourcePrototype)) {
        throw "コピー元フォルダを確認できません: $sourcePrototype"
    }

    if (Test-Path -LiteralPath $targetRoot) {
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backupRoot = Join-Path $tempRoot "znegate-prototype-backup-$timestamp"

        Move-Item `
            -LiteralPath $targetRoot `
            -Destination $backupRoot

        Write-Host "既存フォルダをバックアップしました:"
        Write-Host $backupRoot
    }

    New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null

    Get-ChildItem -LiteralPath $sourcePrototype -Force |
        Copy-Item -Destination $targetRoot -Recurse -Force

    $finalHtml = Join-Path $targetRoot "staging\osaka_3d_buildings.html"

    if (-not (Test-Path -LiteralPath $finalHtml)) {
        throw "コピー後のHTMLを確認できません: $finalHtml"
    }

    Remove-Item -LiteralPath $extractRoot -Recurse -Force

    Write-Host ""
    Write-Host "保存に成功しました。" -ForegroundColor Green
    Write-Host "HTML: $finalHtml"
    Write-Host ""
    Write-Host "次に実行するコマンド:"
    Write-Host 'cd ".\temp\znegate-prototype\staging"'
    Write-Host "py -m http.server 8080"
}
catch {
    Write-Host ""
    Write-Host "処理に失敗しました。" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}