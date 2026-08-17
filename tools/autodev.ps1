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
# Claude Code 呼び出し (完全非対話モード)
# ══════════════════════════════════════════════════════════════
function Invoke-ClaudeAutoDev {
    param(
        [Parameter(Mandatory = $true)][string]$PromptText,
        [Parameter(Mandatory = $true)][int]$MaxTurnsValue,
        [Parameter(Mandatory = $true)][string]$StdErrLogPath
    )
    # -p (print/非対話) + acceptEdits(ファイル編集は自動承認、Bashはallow/denyリストに従う)。
    # --dangerously-skip-permissions は使用しない。
    $claudeArgs = @('-p', '--permission-mode', 'acceptEdits', '--max-turns', "$MaxTurnsValue", '--output-format', 'text', '--allowedTools') `
        + $AllowedToolsList + @('--disallowedTools') + $DisallowedToolsList

    if (($claudeArgs -join ' ') -match 'dangerously-skip-permissions') {
        throw 'internal error: dangerously-skip-permissions が混入しています。処理を中止します。'
    }

    # stdinでpromptを渡す(コマンドライン引数長の制限を回避するため)。
    # stderrは2>&1で合流させず、別ファイルへリダイレクトする(ネイティブコマンドのstderr合流による
    # $LASTEXITCODE誤判定を避けるため)。
    $output = $PromptText | & claude @claudeArgs 2>$StdErrLogPath
    $exitCode = $LASTEXITCODE
    return [PSCustomObject]@{
        Output   = $output
        ExitCode = $exitCode
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

            # ── Claude Code 実行 (完全非対話) ──
            Write-AutoDevLog "claude -p 実行開始 (MaxTurns=$MaxTurns)"
            $claudeResult = Invoke-ClaudeAutoDev -PromptText $fullPrompt -MaxTurnsValue $MaxTurns -StdErrLogPath $stderrLogPath
            Write-AutoDevLog "claude 終了 (exit=$($claudeResult.ExitCode))"

            $stdoutText = ($claudeResult.Output -join "`n")
            Add-Content -LiteralPath $script:LogFilePath -Value "----- claude stdout -----" -Encoding utf8
            Add-Content -LiteralPath $script:LogFilePath -Value (Get-RedactedText -Text $stdoutText) -Encoding utf8
            if (Test-Path -LiteralPath $stderrLogPath) {
                $stderrText = Get-Content -LiteralPath $stderrLogPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
                if ($stderrText) {
                    Add-Content -LiteralPath $script:LogFilePath -Value "----- claude stderr -----" -Encoding utf8
                    Add-Content -LiteralPath $script:LogFilePath -Value (Get-RedactedText -Text $stderrText) -Encoding utf8
                }
            }

            $parsed = Get-AutoDevResultFromOutput -OutputLines $claudeResult.Output
            Write-AutoDevLog "解析結果: RESULT=$($parsed.Result) TASK=$($parsed.Task)"

            if ([string]::IsNullOrWhiteSpace($parsed.Result)) {
                Write-AutoDevLog 'claude出力からAUTODEV_RESULTを解析できませんでした。commitしません。' -Level 'ERROR'
                Write-FinalWrapperResult -Result 'FAILED' -Task $(if ($parsed.Task) { $parsed.Task } else { 'NONE' }) -Branch $dailyBranch -Reason 'AUTODEV_RESULTを出力から解析できませんでした'
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
                    Write-AutoDevLog '安全検証PASS。最終npm testを再実行します。'
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
                        Write-AutoDevLog 'npm test PASS。commitを実行します。'
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
