# tools/invite.ps1 — 팀원 초대 원커맨드 (M8)
# 사용법: powershell -NoProfile -ExecutionPolicy Bypass -File tools\invite.ps1 -Name 홍길동 [-Role member]
# 하는 일: ①Rocky에 계정 생성(토큰 발급) ②원클릭 초대 링크 조립
#          ③슬랙/메시지용 안내문 출력 ④USB/첨부용 .url 바로가기 파일 저장(data\invites\)
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [ValidateSet("member", "admin")][string]$Role = "member",
    [string]$SlackId  # 슬랙 멤버 ID(U로 시작) 지정 시 봇이 직접 DM 발송(자기소멸 초대, M8.5)
)

$ErrorActionPreference = "Stop"
$base = "http://192.168.0.34:8800"

# M8.5: 슬랙 ID가 있으면 봇 DM 경로로 위임 — 토큰이 화면·파일에 안 남는다.
if ($SlackId) {
    Write-Host "== 봇 DM 초대: $Name ($Role) → $SlackId =="
    ssh onofferserver "docker exec deploy-mind-1 node dist/cli.js invite $Name $SlackId --role $Role"
    Write-Host "(팀원이 링크로 첫 인증하면 봇이 DM에서 링크를 자동 삭제합니다. 72시간 미인증 시 링크 만료.)"
    exit $LASTEXITCODE
}

Write-Host "== 계정 생성: $Name ($Role) =="
$output = ssh onofferserver "docker exec deploy-mind-1 node dist/cli.js user add $Name --role $Role" 2>&1 | Out-String
$m = [regex]::Match($output, "[0-9a-f]{64}")
if (-not $m.Success) {
    Write-Host "토큰 발급 실패 — CLI 출력:" -ForegroundColor Red
    Write-Host $output
    exit 1
}
$token = $m.Value
$link = "$base/#token=$token"

# USB/첨부용 바로가기 파일 (data\는 gitignore — 토큰이 레포에 못 들어감)
$invDir = Join-Path $PSScriptRoot "..\data\invites"
New-Item -ItemType Directory -Force $invDir | Out-Null
$urlFile = Join-Path $invDir "cosmos-invite-$Name.url"
@("[InternetShortcut]", "URL=$link") | Out-File -FilePath $urlFile -Encoding ascii

Write-Host ""
Write-Host "== 슬랙 DM / 메시지에 붙여넣기 =="
Write-Host "------------------------------------------------------------"
Write-Host "$Name 님, 온오퍼 지식 코스모스 초대합니다 🪐"
Write-Host ""
Write-Host "아래 링크를 회사 네트워크(사내 와이파이/VPN)에서 한 번 클릭하면 바로 사용 가능해요:"
Write-Host $link
Write-Host ""
Write-Host "- 하단 입력창에 질문하면 회사 지식에서 출처와 함께 답해줍니다"
Write-Host "- 이 링크는 $Name 님 전용이니 다른 사람에게 전달하지 말아 주세요"
Write-Host "------------------------------------------------------------"
Write-Host ""
Write-Host "== USB/파일 전달용 바로가기 저장됨 =="
Write-Host $urlFile
Write-Host "(더블클릭하면 브라우저가 열리며 자동 로그인됩니다)"
Write-Host ""
Write-Host "회수가 필요하면: ssh onofferserver docker exec deploy-mind-1 node dist/cli.js user revoke $Name"
