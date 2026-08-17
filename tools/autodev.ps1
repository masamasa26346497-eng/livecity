<#
.SYNOPSIS
    Live City AutoDev 実行ラッパー。

.DESCRIPTION
    ユーザー不在時に、Claude Code (`claude -p`、完全非対話モード) を起動し、
    AUTODEV_BACKLOG.md から安全な1タスクを選ばせ、調査→実装→テストまでを行わせる。

    【責任分離】Git操作(branch作成/switch・add・commit・push)はすべてこのスクリプト側
    (PowerShell)が担当する。Claude自身にはこれらを一切実行させない
    (--allowedTools / --disallowedTools でツール権限として明示的に禁止する)。
    Claudeが行うのは調査・コード編集・syntax check・npm test・git status/diff/log等の
    読み取りまでで、Git履歴そのものには触れさせない構造にしている。

    --dangerously-skip-permissions は絶対に使用しない(スクリプト内で二重に自己チェックする)。

.PARAMETER BaseBranch
    日次AutoDevブランチ(autodev/YYYY-MM-DD)を新規作成する場合の作成元ブランチ。

.PARAMETER MaxTurns
    `claude -p` に渡す --max-turns の値。

.PARAMETER NoPush
    指定した場合、SUCCESS時にcommitまでは行うが、GitHubへのpushは行わない。

.PARAMETER DryRun
    指定した場合、事前チェック(prerequisites / working tree / BaseBranch存在 / daily branch名 /
    Claude CLI存在 / 必須ファイル存在)のみ行う。Claudeは起動せず、branch作成・switch・
    commit・pushも一切行わない。

.EXAMPLE
    pwsh -File tools/autodev.ps1 -DryRun

.EXAMPLE
    pwsh -File tools/autodev.ps1 -BaseBranch main -MaxTurns 24

.EXAMPLE
    pwsh -File tools/autodev.ps1 -NoPush
#>

[CmdletBinding()]
param(
    [string]$BaseBranch = "feature/ward-expansion-20260817",
    [int]$MaxTurns = 24,
    [switch]$NoPush,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ══════════════════════════════════════════════════════════════
# パス解決
# ══════════════════════════════════════════════════════════════
# $PSScriptRoot はこのスクリプト自身の配置場所(tools/)。プロジェクトルートはその親。
# 固定文字列のパスは使わない。日本語パス・OneDriveパス配下でもそのまま動作させるため、
# 以降のファイル操作はすべて -LiteralPath / Join-Path で組み立てる(ワイルドカード解釈を避ける)。
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TempAutoDevDir = Join-Path $ProjectRoot 'temp\autodev'
$LockFilePath = Join-Path $TempAutoDevDir 'autodev.lock'
$PromptFilePath = Join-Path $ProjectRoot 'AUTODEV_PROMPT.md'

# ══════════════════════════════════════════════════════════════
# 定数
# ══════════════════════════════════════════════════════════════
$BaselineRelativePath = 'public/osaka_3d_buildings.fullward-v3.html'

# production/生成データ領域。tools/build-ward-poc-data.cjs のHARD_DENYリストと同じ考え方を踏襲する
# (=このリポジトリで既に「絶対に書き込ませない」と合意済みの領域と揃える)。
$ProtectedPathPrefixes = @(
    'data/raw/',
    'public/data/buildings/releases/',
    'public/data/buildings/',
    'livecity/'
)

$RequiredFiles = @('AUTODEV_RULES.md', 'AUTODEV_BACKLOG.md', 'AUTODEV_PROMPT.md')
$RequiredCommands = @('git', 'claude', 'node', 'npm')

$MaxFileSizeBytes = 100 * 1024 * 1024  # 100MB

# Claudeに許可するツール。Yes/No確認が発生しないよう、必要最小限のみ事前許可する。
$AllowedToolsList = @(
    'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git ls-files:*)',
    'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(node --check:*)', 'Bash(node --test:*)',
    'Bash(grep:*)', 'Bash(find:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(wc:*)', 'Bash(du:*)'
)

# Git履歴を直接操作するコマンド・破壊的コマンドは明示的に拒否する(denyはallowより優先される前提)。
$DisallowedToolsList = @(
    'Bash(git reset:*)', 'Bash(git clean:*)', 'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git add:*)',
    'Bash(git branch:*)', 'Bash(git switch:*)', 'Bash(git checkout:*)', 'Bash(git restore:*)',
    'Bash(git merge:*)', 'Bash(git rebase:*)',
    'Bash(rm -rf:*)', 'Bash(del:*)', 'Bash(Remove-Item:*)'
)

# 自己防御: --dangerously-skip-permissions が万一どこかに混入していないかを常にチェックする。
foreach ($t in ($AllowedToolsList + $DisallowedToolsList)) {
    if ($t -match 'dangerously-skip-permissions') {
        throw 'internal error: dangerously-skip-permissions が混入しています。処理を中止します。'
    }
}

$script:LogFilePath = $null
$script:LockStream = $null
$script:FinalExitCode = 0
$script:CancelRequested = $false
$script:CancelHandler = $null

# ══════════════════════════════════════════════════════════════
# ログ (secretらしき文字列は簡易マスキングしてから書き出す)
# ══════════════════════════════════════════════════════════════
function Get-RedactedText {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $safe = $Text -replace '(sk-ant-[A-Za-z0-9\-_]+)', '***REDACTED***'
    $safe = $safe -replace '(sk-[A-Za-z0-9]{20,})', '***REDACTED***'
    $safe = $safe -replace '([A-Za-z0-9_]*(API_KEY|TOKEN|SECRET)[A-Za-z0-9_]*\s*[:=]\s*)\S+', '$1***REDACTED***'
    return $safe
}

function Write-AutoDevLog {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Level = 'INFO'
    )
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $safe = Get-RedactedText -Text $Message
    $line = "[$ts][$Level] $safe"
    Write-Host $line
    if ($script:LogFilePath) {
        Add-Content -LiteralPath $script:LogFilePath -Value $line -Encoding utf8
    }
}

function Write-FinalWrapperResult {
    param(
        [Parameter(Mandatory = $true)][string]$Result,
        [string]$Task = 'NONE',
        [string]$Branch = 'NONE',
        [string]$Commit = 'NONE',
        [string]$Pushed = 'false',
        [string]$Reason = $null
    )
    Write-Host ''
    Write-Host "AUTODEV_WRAPPER_RESULT=$Result"
    Write-Host "TASK=$Task"
    Write-Host "BRANCH=$Branch"
    Write-Host "COMMIT=$Commit"
    Write-Host "PUSHED=$Pushed"
    if ($Reason) { Write-Host "REASON=$Reason" }
}

# ══════════════════════════════════════════════════════════════
# 事前チェック系
# ══════════════════════════════════════════════════════════════
function Test-CommandAvailable {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-MissingRequiredFiles {
    param([Parameter(Mandatory = $true)][string[]]$Files, [Parameter(Mandatory = $true)][string]$Root)
    $missing = @()
    foreach ($f in $Files) {
        $p = Join-Path $Root $f
        if (-not (Test-Path -LiteralPath $p)) { $missing += $f }
    }
    # 注意: PowerShellは空配列/要素1件の配列をreturn時に自動的にアンラップし、
    # 呼び出し元で$nullやスカラーになってしまうことがある(Set-StrictMode下で.Count参照が
    # 失敗する原因になる)。単項カンマ演算子で常に配列として返すことを保証する。
    return , $missing
}

function Test-GitWorkingTreeClean {
    $statusOutput = & git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw "git status --porcelain に失敗しました(exit=$LASTEXITCODE)" }
    if ($null -eq $statusOutput) { return $true }
    return (($statusOutput -join '').Trim().Length -eq 0)
}

function Test-GitBranchExists {
    param([Parameter(Mandatory = $true)][string]$BranchName)
    & git rev-parse --verify --quiet ("refs/heads/" + $BranchName) *> $null
    return ($LASTEXITCODE -eq 0)
}

function Get-DailyBranchName {
    return 'autodev/' + (Get-Date -Format 'yyyy-MM-dd')
}

# ══════════════════════════════════════════════════════════════
# 同時実行防止 (lock file、CreateNewによる排他生成)
# ══════════════════════════════════════════════════════════════
function Enter-AutoDevLock {
    param([Parameter(Mandatory = $true)][string]$LockPath)
    $dir = Split-Path -Parent $LockPath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    try {
        $stream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    }
    catch [System.IO.IOException] {
        return $null
    }
    $writer = New-Object System.IO.StreamWriter($stream)
    $writer.WriteLine("pid=$PID")
    $writer.WriteLine("started=" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    $writer.Flush()
    return $stream
}

function Exit-AutoDevLock {
    param($Stream, [Parameter(Mandatory = $true)][string]$LockPath)
    if ($Stream) {
        try { $Stream.Close() } catch { }
    }
    if (Test-Path -LiteralPath $LockPath) {
        try { Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue } catch { }
    }
}

# ══════════════════════════════════════════════════════════════
# Ctrl+C(中断)対応
# ══════════════════════════════════════════════════════════════
# Claude実行中に限定してConsole.CancelKeyPressを捕捉する。$e.Cancel=$trueで既定の即時終了を
# 止め、$script:CancelRequestedフラグだけを立てる。実際の子プロセス終了・後片付けは
# Start-StreamedExternalProcess側のポーリングループが responsible に行う。
# Claude実行区間の外(git操作・npm test等)ではこのハンドラは登録しない
# (登録したままだとCtrl+Cが「効かなくなったように見える」区間を作ってしまうため、
#  Claude実行の直前で登録し、直後に必ず解除する)。
function Register-AutoDevCancelHandler {
    $script:CancelRequested = $false
    $script:CancelHandler = [System.ConsoleCancelEventHandler]{
        param($sender, $e)
        $script:CancelRequested = $true
        $e.Cancel = $true
    }
    [Console]::add_CancelKeyPress($script:CancelHandler)
}

function Unregister-AutoDevCancelHandler {
    if ($script:CancelHandler) {
        try { [Console]::remove_CancelKeyPress($script:CancelHandler) } catch { }
        $script:CancelHandler = $null
    }
}

# ══════════════════════════════════════════════════════════════
# ブランチ管理 (PowerShell側の責任。Claudeには一切行わせない)
# ══════════════════════════════════════════════════════════════
function Set-DailyAutoDevBranch {
    param(
        [Parameter(Mandatory = $true)][string]$DailyBranch,
        [Parameter(Mandatory = $true)][string]$BaseBranchName
    )
    if (Test-GitBranchExists -BranchName $DailyBranch) {
        Write-AutoDevLog "日次ブランチ $DailyBranch は既存のためswitchします。"
        & git switch $DailyBranch
        if ($LASTEXITCODE -ne 0) { throw "git switch $DailyBranch に失敗しました(exit=$LASTEXITCODE)" }
    }
    else {
        Write-AutoDevLog "日次ブランチ $DailyBranch を $BaseBranchName から新規作成します。"
        & git switch -c $DailyBranch $BaseBranchName
        if ($LASTEXITCODE -ne 0) { throw "git switch -c $DailyBranch $BaseBranchName に失敗しました(exit=$LASTEXITCODE)" }
    }
    $current = (& git rev-parse --abbrev-ref HEAD).Trim()
    if ($current -ne $DailyBranch) {
        throw "現在のbranchが期待値と異なります(期待=$DailyBranch, 実際=$current)"
    }
    if ($current -eq 'main') {
        throw 'internal error: mainブランチ上での実行を検出しました。中止します。'
    }
}

# ══════════════════════════════════════════════════════════════
# claude CLI解決 (claude.exe / claude.cmd / claude.ps1 shim等、環境依存の実行形式を吸収する)
# ══════════════════════════════════════════════════════════════
# Get-Commandは、PowerShellの&演算子が内部的に使うのと同じコマンド解決ロジックを使うため、
# 「現在すでに正常に起動できているclaude解決」をそのまま踏襲できる(パスを独自に推測しない)。
# 実機確認の結果、npmグローバルインストールでは claude.ps1 (ExternalScript) として解決される
# ケースがあることを確認済み(claude.cmd/claude.exeとは別に扱う必要がある。
# cmd.exeは.ps1を直接解決できないため、.cmd/.batと同じフォールバックには乗せられない)。
# .exeはCreateProcessで直接起動できるが、.cmd/.bat/.ps1のshimは直接起動できないため、
# それぞれ対応するインタプリタ(cmd.exe / powershell.exe)経由で起動する。
function Resolve-ClaudeInvocation {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'claude CLI が見つかりません(PATH上に存在しません)。' }

    $source = $null
    try { $source = $cmd.Source } catch { $source = $null }

    if ([string]::IsNullOrWhiteSpace($source)) {
        # function/alias等、実行ファイルパスを直接持たない場合の安全側フォールバック。
        # cmd.exe自身のPATH/PATHEXT解決に任せる(通常のコンソールで`claude`と打つのと同じ経路)。
        return [PSCustomObject]@{ FileName = $env:ComSpec; PrefixArgs = @('/c', 'claude') }
    }

    $ext = [System.IO.Path]::GetExtension($source).ToLowerInvariant()
    if ($ext -eq '.exe') {
        return [PSCustomObject]@{ FileName = $source; PrefixArgs = @() }
    }
    elseif ($ext -eq '.cmd' -or $ext -eq '.bat') {
        return [PSCustomObject]@{ FileName = $env:ComSpec; PrefixArgs = @('/c', $source) }
    }
    elseif ($ext -eq '.ps1') {
        $psExeCmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
        $psExe = if ($psExeCmd) { $psExeCmd.Source } else { 'powershell.exe' }
        return [PSCustomObject]@{ FileName = $psExe; PrefixArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $source) }
    }
    else {
        # 未知のその他の形式は、安全側にcmd.exe経由のPATH解決へフォールバックする。
        return [PSCustomObject]@{ FileName = $env:ComSpec; PrefixArgs = @('/c', 'claude') }
    }
}

# ══════════════════════════════════════════════════════════════
# コマンドライン引数の組み立て (Win32標準のargvクォート規則)
# ══════════════════════════════════════════════════════════════
# 【実機確認による重要な注意】ProcessStartInfo.ArgumentListは.NET Core/最新.NETでは
# 自動初期化された空Collectionだが、このスクリプトが動くWindows PowerShell 5.1(.NET Framework)の
# 実機では取得時に$null・代入時にプロパティが見つからないエラーとなり、実際には使用できないことを
# 実機テストで確認した。そのため、従来からある単一文字列のProcessStartInfo.Argumentsへ、
# 標準的なWin32コマンドライン引数エスケープ規則(CommandLineToArgvW互換)で自前組み立てする。
function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Arg)
    if ($Arg.Length -gt 0 -and $Arg.IndexOfAny([char[]]@(' ', '"', "`t")) -lt 0) {
        return $Arg
    }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $len = $Arg.Length
    for ($i = 0; $i -lt $len; $i++) {
        $numBackslashes = 0
        while ($i -lt $len -and $Arg[$i] -eq '\') { $numBackslashes++; $i++ }
        if ($i -eq $len) {
            [void]$sb.Append('\', ($numBackslashes * 2))
            break
        }
        elseif ($Arg[$i] -eq '"') {
            [void]$sb.Append('\', ($numBackslashes * 2 + 1))
            [void]$sb.Append('"')
        }
        else {
            [void]$sb.Append('\', $numBackslashes)
            [void]$sb.Append($Arg[$i])
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Get-WindowsCommandLine {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Arguments)
    return (($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join ' ')
}

# ══════════════════════════════════════════════════════════════
# 汎用: 子プロセスをリアルタイムでstream実行するヘルパー
# ══════════════════════════════════════════════════════════════
# System.Diagnostics.Process(UseShellExecute=false、標準出力/エラーをリダイレクト)で子プロセスを
# 起動し、stdout/stderrを行単位の非同期イベントでスレッドセーフなConcurrentQueueへ積む。
# 呼び出し元のポーリングループがそれを取り出してConsole表示・ログ保存を行うため、
# 実行完了まで全出力をメモリへ溜め込んでから表示する方式にはならない。
# $script:CancelRequestedがtrueになった場合、taskkillで子プロセスをプロセスツリーごと終了する。
function Start-StreamedExternalProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [string]$InputText,
        [Parameter(Mandatory = $true)][scriptblock]$OnStdOutLine,
        [Parameter(Mandatory = $true)][scriptblock]$OnStdErrLine,
        [int]$PollIntervalMs = 100
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FileName
    $psi.Arguments = Get-WindowsCommandLine -Arguments $ArgumentList
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $process.EnableRaisingEvents = $true

    $stdoutQueue = New-Object System.Collections.Concurrent.ConcurrentQueue[string]
    $stderrQueue = New-Object System.Collections.Concurrent.ConcurrentQueue[string]

    $outSub = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData $stdoutQueue -Action {
        if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) }
    }
    $errSub = Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -MessageData $stderrQueue -Action {
        if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) }
    }

    $cancelled = $false
    try {
        [void]$process.Start()
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()

        if ($InputText) {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($InputText)
            $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
            $process.StandardInput.BaseStream.Flush()
        }
        $process.StandardInput.Close()

        # [重要] & $OnStdOutLine 等のハンドラ呼び出しは[void](...)で必ず包む。ハンドラ内部が
        # (Write-Hostではなく)Write-Output等でパイプラインへ出力してしまった場合でも、それが
        # この関数自身の戻り値(最後のreturn文のPSCustomObject)を汚染しないようにするため。
        while (-not $process.HasExited) {
            $line = $null
            while ($stdoutQueue.TryDequeue([ref]$line)) { [void](& $OnStdOutLine $line) }
            while ($stderrQueue.TryDequeue([ref]$line)) { [void](& $OnStdErrLine $line) }
            if ($script:CancelRequested) {
                $cancelled = $true
                break
            }
            Start-Sleep -Milliseconds $PollIntervalMs
        }

        if ($cancelled) {
            try {
                if (-not $process.HasExited) {
                    # .NET Framework(Windows PowerShell 5.1)のProcess.Kill()にはプロセスツリー一括
                    # 終了オプションが無い。claudeがcmd.exe/.cmd shim経由の場合、直下だけkillしても
                    # 実体(node.exe等)の孫プロセスが残留しうるため、taskkillでツリーごと確実に終了する。
                    & taskkill /PID $process.Id /T /F *> $null
                }
            }
            catch { }
            try { $process.WaitForExit(5000) | Out-Null } catch { }
        }
        else {
            [void]$process.WaitForExit()
        }

        # 終了直後、イベント配信が遅延している可能性があるため少し待ってから最終ドレインする。
        Start-Sleep -Milliseconds 150
        $line = $null
        while ($stdoutQueue.TryDequeue([ref]$line)) { [void](& $OnStdOutLine $line) }
        while ($stderrQueue.TryDequeue([ref]$line)) { [void](& $OnStdErrLine $line) }

        $exitCode = if ($cancelled) { 130 } else { $process.ExitCode }
        return [PSCustomObject]@{ ExitCode = $exitCode; Cancelled = $cancelled; ProcessId = $process.Id }
    }
    finally {
        try { Unregister-Event -SourceIdentifier $outSub.Name -ErrorAction SilentlyContinue } catch { }
        try { Unregister-Event -SourceIdentifier $errSub.Name -ErrorAction SilentlyContinue } catch { }
        try { Remove-Job -Id $outSub.Id -Force -ErrorAction SilentlyContinue } catch { }
        try { Remove-Job -Id $errSub.Id -Force -ErrorAction SilentlyContinue } catch { }
        try { $process.Dispose() } catch { }
    }
}

# ══════════════════════════════════════════════════════════════
# Claude Code 呼び出し (完全非対話モード、リアルタイム出力表示)
# ══════════════════════════════════════════════════════════════
function Invoke-ClaudeAutoDev {
    param(
        [Parameter(Mandatory = $true)][string]$PromptText,
        [Parameter(Mandatory = $true)][int]$MaxTurnsValue,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$StdErrLogPath
    )
    # -p (print/非対話) + acceptEdits(ファイル編集は自動承認、Bashはallow/denyリストに従う)。
    # --dangerously-skip-permissions は使用しない。
    $claudeArgs = @('-p', '--permission-mode', 'acceptEdits', '--max-turns', "$MaxTurnsValue", '--output-format', 'text', '--allowedTools') `
        + $AllowedToolsList + @('--disallowedTools') + $DisallowedToolsList

    if (($claudeArgs -join ' ') -match 'dangerously-skip-permissions') {
        throw 'internal error: dangerously-skip-permissions が混入しています。処理を中止します。'
    }

    $resolved = Resolve-ClaudeInvocation
    $fullArgs = @($resolved.PrefixArgs) + $claudeArgs
    Write-AutoDevLog "claude 解決先: $($resolved.FileName) $($resolved.PrefixArgs -join ' ')"

    # AUTODEV_RESULT等の最終出力解析用に、直近N行だけを保持する(全出力の無制限保持はしない)。
    $maxBufferLines = 500
    $stdoutBuffer = New-Object System.Collections.Generic.List[string]

    $onStdOut = {
        param($line)
        $redacted = Get-RedactedText -Text $line
        Write-Host "[claude] $redacted"
        if ($script:LogFilePath) { Add-Content -LiteralPath $script:LogFilePath -Value "[claude][stdout] $redacted" -Encoding utf8 }
        $stdoutBuffer.Add($line)
        if ($stdoutBuffer.Count -gt $maxBufferLines) { $stdoutBuffer.RemoveAt(0) }
    }.GetNewClosure()

    $onStdErr = {
        param($line)
        $redacted = Get-RedactedText -Text $line
        Write-Host "[claude:stderr] $redacted" -ForegroundColor Yellow
        Add-Content -LiteralPath $StdErrLogPath -Value $redacted -Encoding utf8
    }.GetNewClosure()

    $result = Start-StreamedExternalProcess -FileName $resolved.FileName -ArgumentList $fullArgs -WorkingDirectory $WorkingDirectory `
        -InputText $PromptText -OnStdOutLine $onStdOut -OnStdErrLine $onStdErr

    return [PSCustomObject]@{
        ExitCode    = $result.ExitCode
        Cancelled   = $result.Cancelled
        OutputLines = $stdoutBuffer.ToArray()
    }
}

function Get-AutoDevResultFromOutput {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$OutputLines)
    $text = ($OutputLines -join "`n")
    $result = [PSCustomObject]@{ Result = $null; Task = $null; Branch = $null; Commit = $null; Report = $null }
    foreach ($key in @('Result', 'Task', 'Branch', 'Commit', 'Report')) {
        $fieldName = if ($key -eq 'Result') { 'AUTODEV_RESULT' } else { $key.ToUpper() }
        $m = [regex]::Matches($text, "(?m)^$fieldName=(.*)$")
        if ($m.Count -gt 0) {
            $result.$key = $m[$m.Count - 1].Groups[1].Value.Trim()
        }
    }
    return $result
}

# ══════════════════════════════════════════════════════════════
# SUCCESS後の安全検証 (PowerShell側の独立確認。Claude自己申告のSUCCESSを鵜呑みにしない)
# ══════════════════════════════════════════════════════════════
function Test-BaselineUnchanged {
    param([Parameter(Mandatory = $true)][string]$BaselinePath)
    & git diff --quiet -- $BaselinePath
    $unstagedOk = ($LASTEXITCODE -eq 0)
    if (-not $unstagedOk) { return $false }
    # untrackedとして新規作成された場合(通常あり得ないが念のため)も検知する。
    $untracked = & git status --porcelain -- $BaselinePath
    if ($untracked -and (($untracked -join '').Trim().Length -gt 0)) { return $false }
    return $true
}

function Get-ChangedPaths {
    # working tree上の変更(untracked含む)を相対パスの配列で返す。
    # (注意: 空配列/1件配列のreturn自動アンラップ対策として、常に単項カンマで配列を返す)
    $lines = & git status --porcelain
    $paths = @()
    if ($null -eq $lines) { return , $paths }
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $p = $line.Substring(3)
        if ($p -match '^"(.*)"$') { $p = $Matches[1] }
        if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1] }
        $paths += $p.Trim()
    }
    return , $paths
}

function Get-ProtectedPathHits {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ChangedPaths, [Parameter(Mandatory = $true)][string[]]$ProtectedPrefixes)
    $hits = @()
    foreach ($p in $ChangedPaths) {
        foreach ($prefix in $ProtectedPrefixes) {
            if ($p.StartsWith($prefix)) { $hits += $p; break }
        }
    }
    return , $hits
}

function Get-OversizedFiles {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ChangedPaths, [Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][long]$MaxBytes)
    $tooLarge = @()
    foreach ($p in $ChangedPaths) {
        $full = Join-Path $Root $p
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $len = (Get-Item -LiteralPath $full).Length
            if ($len -gt $MaxBytes) {
                $mb = [math]::Round($len / 1MB, 1)
                $tooLarge += "$p (${mb}MB)"
            }
        }
    }
    return , $tooLarge
}

function Test-GitDiffCheckClean {
    param([switch]$Cached)
    if ($Cached) { $out = & git diff --cached --check } else { $out = & git diff --check }
    $ok = ($LASTEXITCODE -eq 0)
    return [PSCustomObject]@{ Ok = $ok; Output = $out }
}

function Invoke-FinalNpmTest {
    & npm test *>&1 | ForEach-Object { $_.ToString() }
}

# ══════════════════════════════════════════════════════════════
# commit / push
# ══════════════════════════════════════════════════════════════
function Get-SanitizedTaskId {
    param([string]$RawTask)
    if ([string]::IsNullOrWhiteSpace($RawTask)) { return 'unknown-task' }
    $t = $RawTask -replace '[\r\n\t]', ' '
    $t = $t -replace '[^\p{L}\p{Nd}\-_/. ]', ''
    $t = $t.Trim()
    if ($t.Length -gt 80) { $t = $t.Substring(0, 80) }
    if ([string]::IsNullOrWhiteSpace($t)) { return 'unknown-task' }
    return $t
}

function Invoke-AutoDevCommit {
    param([Parameter(Mandatory = $true)][string]$TaskId)

    & git add -A
    if ($LASTEXITCODE -ne 0) { throw "git add -A に失敗しました(exit=$LASTEXITCODE)" }

    $cachedCheck = Test-GitDiffCheckClean -Cached
    if (-not $cachedCheck.Ok) {
        throw "git diff --cached --check で問題が検出されました: $($cachedCheck.Output -join "`n")"
    }

    $stagedFiles = & git diff --cached --name-only
    if ($null -eq $stagedFiles -or ($stagedFiles -join '').Trim().Length -eq 0) {
        Write-AutoDevLog 'staged差分が無いため、commitをスキップします(empty commitは作成しません)。'
        return $null
    }

    $sanitized = Get-SanitizedTaskId -RawTask $TaskId
    $message = "AutoDev: $sanitized"
    & git commit -m $message
    if ($LASTEXITCODE -ne 0) { throw "git commit に失敗しました(exit=$LASTEXITCODE)" }

    return (& git rev-parse HEAD).Trim()
}

function Invoke-AutoDevPush {
    param([Parameter(Mandatory = $true)][string]$Branch)
    if ($Branch -eq 'main') { throw 'internal error: mainへのpushは禁止されています。' }
    & git push -u origin $Branch
    return ($LASTEXITCODE -eq 0)
}

# ══════════════════════════════════════════════════════════════
# メイン処理
# ══════════════════════════════════════════════════════════════
try {
    # ── 実行タイムスタンプ・ログ準備 ──
    $runTimestamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
    if (-not (Test-Path -LiteralPath $TempAutoDevDir)) {
        New-Item -ItemType Directory -Path $TempAutoDevDir -Force | Out-Null
    }
    $script:LogFilePath = Join-Path $TempAutoDevDir ($runTimestamp + '.log')
    $stderrLogPath = Join-Path $TempAutoDevDir ($runTimestamp + '.stderr.log')

    Write-AutoDevLog "=== Live City AutoDev 開始 (DryRun=$($DryRun.IsPresent), NoPush=$($NoPush.IsPresent)) ==="
    Write-AutoDevLog "ProjectRoot = $ProjectRoot"

    # temp/ がgitignore対象であることの確認(.gitignoreは変更しない、確認のみ)。
    Push-Location -LiteralPath $ProjectRoot
    try {
        & git check-ignore -q -- 'temp/autodev/probe' 2> $null
        if ($LASTEXITCODE -ne 0) {
            Write-AutoDevLog 'temp/ が.gitignoreの対象になっていない可能性があります(確認のみ、処理は継続します)。' -Level 'WARN'
        }
    }
    finally {
        Pop-Location
    }

    # ── 事前チェック (読み取りのみ、ここまではlock不要) ──
    Push-Location -LiteralPath $ProjectRoot
    try {
        $missingCommands = @()
        foreach ($cmd in $RequiredCommands) {
            if (-not (Test-CommandAvailable -Name $cmd)) { $missingCommands += $cmd }
        }
        $missingFiles = Get-MissingRequiredFiles -Files $RequiredFiles -Root $ProjectRoot
        $workingTreeClean = Test-GitWorkingTreeClean
        $baseBranchExists = Test-GitBranchExists -BranchName $BaseBranch
        $dailyBranch = Get-DailyBranchName
        $dailyBranchExists = Test-GitBranchExists -BranchName $dailyBranch
    }
    finally {
        Pop-Location
    }

    Write-AutoDevLog "必須コマンド不足: $(if (@($missingCommands).Count -eq 0) { '(なし)' } else { $missingCommands -join ', ' })"
    Write-AutoDevLog "必須ファイル不足: $(if (@($missingFiles).Count -eq 0) { '(なし)' } else { $missingFiles -join ', ' })"
    Write-AutoDevLog "working tree clean: $workingTreeClean"
    Write-AutoDevLog "BaseBranch ($BaseBranch) 存在: $baseBranchExists"
    Write-AutoDevLog "daily branch: $dailyBranch (存在=$dailyBranchExists)"

    $prerequisitesOk = (@($missingCommands).Count -eq 0) -and (@($missingFiles).Count -eq 0) -and $baseBranchExists

    if ($DryRun) {
        # ── DryRun: prerequisites / git clean / BaseBranch存在 / daily branch名 / Claude CLI存在 /
        #    必須ファイル存在 だけを確認する。branch作成・switch・Claude起動・commit・pushは一切しない。
        $allOk = $prerequisitesOk -and $workingTreeClean
        if ($allOk) {
            Write-AutoDevLog 'DryRun: 全チェックPASS'
            Write-Host 'AUTODEV_DRYRUN=OK'
            $script:FinalExitCode = 0
        }
        else {
            Write-AutoDevLog 'DryRun: 一部チェックがFAILしました' -Level 'WARN'
            Write-Host 'AUTODEV_DRYRUN=FAILED'
            $script:FinalExitCode = 1
        }
    }
    else {
        # ── 通常実行 ──
        if (@($missingCommands).Count -gt 0) {
            throw "ABORT|PREREQUISITES_MISSING|必須コマンドが見つかりません: $($missingCommands -join ', ')"
        }
        if (@($missingFiles).Count -gt 0) {
            throw "ABORT|PREREQUISITES_MISSING|必須ファイルが見つかりません: $($missingFiles -join ', ')"
        }
        if (-not $workingTreeClean) {
            throw 'ABORT|DIRTY_WORKTREE|working treeがcleanではありません。既存のユーザー変更には触れず終了します。'
        }
        if (-not $baseBranchExists) {
            throw "ABORT|BASE_BRANCH_NOT_FOUND|BaseBranch '$BaseBranch' がローカルに存在しません。"
        }

        # ── 同時実行防止 ──
        $script:LockStream = Enter-AutoDevLock -LockPath $LockFilePath
        if ($null -eq $script:LockStream) {
            throw 'ABORT|ALREADY_RUNNING|別のAutoDevプロセスが実行中です(lock file取得失敗)。'
        }
        Write-AutoDevLog 'lock取得OK'

        Push-Location -LiteralPath $ProjectRoot
        try {
            # ── 日次ブランチの作成/switch (PowerShell側の責任) ──
            Set-DailyAutoDevBranch -DailyBranch $dailyBranch -BaseBranchName $BaseBranch
            Write-AutoDevLog "現在のbranch: $dailyBranch"

            # ── プロンプト組み立て ──
            $basePrompt = Get-Content -LiteralPath $PromptFilePath -Raw -Encoding UTF8
            $wrapperNote = @"

---

[AutoDev Wrapper 追加指示]
このセッションはPowerShellラッパー(tools/autodev.ps1)から起動されています。
branchは既にPowerShell側で準備済みです。現在のbranchは $dailyBranch です。
Claude自身はgit branch / git switch / git checkout / git add / git commit / git push を
実行しないでください(ツール権限上も許可されていません)。安全確認・commit・pushはすべて
PowerShell側が行います。
"@
            $fullPrompt = $basePrompt + $wrapperNote

            # ── Claude Code 実行 (完全非対話、リアルタイム出力表示) ──
            # Ctrl+CハンドラはClaude実行区間だけに限定して登録する(区間外はPowerShell既定の
            # Ctrl+C挙動のままにするため、必ずfinallyで解除する)。
            Write-AutoDevLog '[AutoDev] Claude起動'
            Register-AutoDevCancelHandler
            try {
                Write-AutoDevLog "[AutoDev] Claude実行中 (MaxTurns=$MaxTurns)"
                $claudeResult = Invoke-ClaudeAutoDev -PromptText $fullPrompt -MaxTurnsValue $MaxTurns -WorkingDirectory $ProjectRoot -StdErrLogPath $stderrLogPath
            }
            finally {
                Unregister-AutoDevCancelHandler
            }
            Write-AutoDevLog "[AutoDev] Claude終了 ExitCode=$($claudeResult.ExitCode)"

            if ($claudeResult.Cancelled) {
                # Ctrl+C: commit/push/git addは一切行わない。working treeもrestoreしない。
                Write-AutoDevLog 'ユーザーによる中断(Ctrl+C)を検出しました。commit/push/git addは行わず終了します。' -Level 'WARN'
                Write-FinalWrapperResult -Result 'CANCELLED' -Branch $dailyBranch -Reason 'USER_CANCELLED'
                $script:FinalExitCode = 130
            }
            elseif ($claudeResult.ExitCode -ne 0) {
                Write-AutoDevLog "claudeプロセスが異常終了しました(exit=$($claudeResult.ExitCode))。commitしません。" -Level 'ERROR'
                Write-FinalWrapperResult -Result 'FAILED' -Branch $dailyBranch -Reason "CLAUDE_EXIT_$($claudeResult.ExitCode)"
                $script:FinalExitCode = 5
            }
            else {

            $parsed = Get-AutoDevResultFromOutput -OutputLines $claudeResult.OutputLines
            Write-AutoDevLog "解析結果: RESULT=$($parsed.Result) TASK=$($parsed.Task)"

            if ([string]::IsNullOrWhiteSpace($parsed.Result)) {
                Write-AutoDevLog 'claude出力からAUTODEV_RESULTを解析できませんでした。commitしません。' -Level 'ERROR'
                Write-FinalWrapperResult -Result 'FAILED' -Task $(if ($parsed.Task) { $parsed.Task } else { 'NONE' }) -Branch $dailyBranch -Reason 'CLAUDE_RESULT_MISSING'
                $script:FinalExitCode = 5
            }
            elseif ($parsed.Result -ne 'SUCCESS') {
                # FAILED / BLOCKED / NEEDS_USER_DECISION: commitしない。ユーザー入力待ちにはしない。
                Write-AutoDevLog "タスク結果は $($parsed.Result) のため、commitしません。" -Level 'WARN'
                Write-FinalWrapperResult -Result $parsed.Result -Task $(if ($parsed.Task) { $parsed.Task } else { 'NONE' }) -Branch $dailyBranch
                $script:FinalExitCode = switch ($parsed.Result) {
                    'BLOCKED' { 3 }
                    'NEEDS_USER_DECISION' { 4 }
                    default { 5 }
                }
            }
            else {
                # ── SUCCESS: PowerShell側で独立に安全検証してからでないとcommitしない ──
                Write-AutoDevLog '[AutoDev] SUCCESS後安全チェック開始'
                $unstagedCheck = Test-GitDiffCheckClean
                $baselineOk = Test-BaselineUnchanged -BaselinePath $BaselineRelativePath
                $changedPaths = Get-ChangedPaths
                $protectedHits = Get-ProtectedPathHits -ChangedPaths $changedPaths -ProtectedPrefixes $ProtectedPathPrefixes
                $oversized = Get-OversizedFiles -ChangedPaths $changedPaths -Root $ProjectRoot -MaxBytes $MaxFileSizeBytes

                $safetyFailReasons = @()
                if (-not $unstagedCheck.Ok) { $safetyFailReasons += 'git diff --check で問題が検出されました' }
                if (-not $baselineOk) { $safetyFailReasons += "baseline ($BaselineRelativePath) が変更されています" }
                if (@($protectedHits).Count -gt 0) { $safetyFailReasons += "禁止領域が変更されています: $($protectedHits -join ', ')" }
                if (@($oversized).Count -gt 0) { $safetyFailReasons += "100MBを超えるファイルが含まれています: $($oversized -join ', ')" }

                if ($safetyFailReasons.Count -gt 0) {
                    $reasonText = $safetyFailReasons -join ' / '
                    Write-AutoDevLog "SUCCESS後の安全検証NG(commitしません): $reasonText" -Level 'ERROR'
                    Write-FinalWrapperResult -Result 'FAILED' -Task $parsed.Task -Branch $dailyBranch -Reason $reasonText
                    $script:FinalExitCode = 5
                }
                else {
                    Write-AutoDevLog '[AutoDev] npm test開始'
                    $testOutput = Invoke-FinalNpmTest
                    $testExit = $LASTEXITCODE
                    Add-Content -LiteralPath $script:LogFilePath -Value "----- npm test (final) -----" -Encoding utf8
                    Add-Content -LiteralPath $script:LogFilePath -Value (Get-RedactedText -Text ($testOutput -join "`n")) -Encoding utf8

                    if ($testExit -ne 0) {
                        Write-AutoDevLog "最終npm testがfailしました(exit=$testExit)。commitしません。" -Level 'ERROR'
                        Write-FinalWrapperResult -Result 'FAILED' -Task $parsed.Task -Branch $dailyBranch -Reason 'npm testが最終確認でfailしました'
                        $script:FinalExitCode = 5
                    }
                    else {
                        Write-AutoDevLog '[AutoDev] commit開始'
                        $commitHash = Invoke-AutoDevCommit -TaskId $parsed.Task

                        $pushed = $false
                        if ($null -ne $commitHash) {
                            if (-not $NoPush) {
                                Write-AutoDevLog "git push -u origin $dailyBranch を実行します。"
                                $pushed = Invoke-AutoDevPush -Branch $dailyBranch
                                if (-not $pushed) {
                                    Write-AutoDevLog 'pushに失敗しました(認証等の可能性)。commitはローカルに残しています。' -Level 'WARN'
                                }
                            }
                            else {
                                Write-AutoDevLog '-NoPush指定のため、pushをスキップします。'
                            }
                        }

                        $commitDisplay = if ($commitHash) { $commitHash } else { 'NONE' }
                        Write-FinalWrapperResult -Result 'SUCCESS' -Task $parsed.Task -Branch $dailyBranch -Commit $commitDisplay -Pushed $(if ($pushed) { 'true' } else { 'false' })
                        $script:FinalExitCode = 0
                    }
                }
            }
            } # Cancelled/ExitCode!=0 チェックのelse(=claudeが正常終了しAUTODEV_RESULT解析へ進むケース)を閉じる
        }
        finally {
            Pop-Location
        }
    }
}
catch {
    $msg = $_.Exception.Message
    if ($msg -like 'ABORT|*') {
        $parts = $msg -split '\|', 3
        $code = $parts[1]
        $reason = if ($parts.Count -ge 3) { $parts[2] } else { '' }
        Write-AutoDevLog "AUTODEV_ABORTED=$code $reason" -Level 'WARN'
        Write-Host "AUTODEV_ABORTED=$code"
        Write-FinalWrapperResult -Result 'FAILED' -Reason $reason
        $script:FinalExitCode = 2
    }
    else {
        Write-AutoDevLog "予期しないエラー: $msg" -Level 'ERROR'
        Write-FinalWrapperResult -Result 'FAILED' -Reason $msg
        $script:FinalExitCode = 1
    }
}
finally {
    if ($script:LockStream) {
        Exit-AutoDevLock -Stream $script:LockStream -LockPath $LockFilePath
        $script:LockStream = $null
    }
    try { Pop-Location -ErrorAction SilentlyContinue } catch { }
    Write-AutoDevLog "=== Live City AutoDev 終了 (ExitCode=$script:FinalExitCode) ==="
}

exit $script:FinalExitCode
