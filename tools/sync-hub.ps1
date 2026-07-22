# tools/sync-hub.ps1
# data/cosmos_token.txt를 읽어 mind CLI의 scan을 원격 mind(192.168.0.34:8800)에 대해
# 실행하고, 결과 요약 한 줄을 data/sync-hub.log에 append한다.
# 실패해도 항상 exit 0 (로그만 남기고 조용히 종료 — 스케줄 실행을 막지 않는다).
#
# 사용법: powershell -NoProfile -ExecutionPolicy Bypass -File tools\sync-hub.ps1

$repoRoot = Split-Path -Parent $PSScriptRoot
$tokenPath = Join-Path $repoRoot 'data\cosmos_token.txt'
$logPath = Join-Path $repoRoot 'data\sync-hub.log'
$cliPath = Join-Path $repoRoot 'mind\dist\cli.js'

function Write-SyncLog {
    param([string]$Message)

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
    $line = "$timestamp scan: $Message"

    $existing = @()
    if (Test-Path -Path $logPath) {
        $existing = @(Get-Content -Path $logPath -Encoding utf8)
    }
    $existing += $line
    if ($existing.Count -gt 200) {
        $existing = $existing[($existing.Count - 200)..($existing.Count - 1)]
    }
    $existing | Out-File -FilePath $logPath -Encoding utf8
}

try {
    if (-not (Test-Path -Path $tokenPath)) {
        try { Write-SyncLog '토큰 파일 없음 (data\cosmos_token.txt) - 건너뜀' } catch {}
        exit 0
    }

    $token = (Get-Content -Path $tokenPath -Encoding utf8 -Raw).Trim()

    $env:COSMOS_MIND_URL = 'http://192.168.0.34:8800'
    $env:COSMOS_TOKEN = $token

    $output = & node $cliPath scan
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        Write-SyncLog "실패 (exit $exitCode)"
        exit 0
    }

    $jsonText = ($output -join "`n").Trim()
    # scan은 JSON을 stdout에 찍지만 watcher 경고가 앞에 섞일 수 있으므로 첫 '{'부터 잘라낸다.
    $braceIndex = $jsonText.IndexOf('{')
    if ($braceIndex -gt 0) {
        $jsonText = $jsonText.Substring($braceIndex)
    }
    try {
        $result = $jsonText | ConvertFrom-Json
        $failedCount = if ($result.failed) { @($result.failed).Count } else { 0 }
        $summary = "scanned=$($result.scanned) ingested=$($result.ingested) duplicate=$($result.duplicate) replaced=$($result.replaced) failed=$failedCount"
    } catch {
        $preview = $jsonText.Substring(0, [Math]::Min(200, $jsonText.Length))
        $summary = "출력 파싱 실패: $preview"
    }

    Write-SyncLog $summary
    exit 0
} catch {
    try { Write-SyncLog "예외: $($_.Exception.Message)" } catch {}
    exit 0
}
