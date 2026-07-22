# 코스모스 개인 지식 킷 설치기 — 팀원 원라이너:  iex (irm {{PUBLIC_URL}}/kit)
# 하는 일: 노트 폴더 생성 → 킷 다운로드 → 토큰 입력 → 초기화(-Init) → (선택) 매일 자동 동기화 등록.
# (주의) 이 파일은 iex(irm) 전용이라 일부러 BOM이 없다 — BOM이 있으면 irm 문자열 맨 앞의
# FEFF가 첫 줄 주석 처리를 깨서 오동작한다(실측). PS5.1로 디스크에서 직접 실행하려면 BOM을 붙일 것.
$ErrorActionPreference = 'Stop'
$Url = if ($env:COSMOS_URL) { $env:COSMOS_URL } else { '{{PUBLIC_URL}}' }
$Folder = if ($env:COSMOS_KIT_FOLDER) { $env:COSMOS_KIT_FOLDER } else { "$env:USERPROFILE\cosmos-knowledge" }

New-Item -ItemType Directory -Force $Folder | Out-Null
$kit = Join-Path $Folder 'my-knowledge.ps1'
Invoke-RestMethod "$Url/web/kit/my-knowledge.ps1" -OutFile $kit

$tok = $env:COSMOS_TOKEN
if (-not $tok) { $tok = Read-Host '초대 DM의 토큰을 붙여넣으세요' }

& $kit -Init -Token $tok -Folder $Folder -Url $Url

# 스케줄 등록: 원클릭(.cmd, COSMOS_KIT_AUTO=1)이면 묻지 않고 자동 등록,
# 수동 원라이너면 물어본다. COSMOS_KIT_NO_SCHEDULE=1은 테스트용 건너뛰기.
if (-not $env:COSMOS_KIT_NO_SCHEDULE) {
  if ($env:COSMOS_KIT_AUTO) {
    & $kit -Schedule -Folder $Folder -Url $Url
  } else {
    $ans = Read-Host '매일 09:37 자동 동기화를 등록할까요? (y/N)'
    if ($ans -match '^[yY]') { & $kit -Schedule -Folder $Folder -Url $Url }
  }
}

Write-Output ''
Write-Output "설치 완료! 노트 폴더: $Folder"
Write-Output "노트(.md)를 쓰고:  cd $Folder ; .\my-knowledge.ps1 -Sync  (자동 동기화 등록 시엔 그냥 두면 매일 반영)"
Write-Output "웹에서 보기: $Url (내 성운은 '개인 ·' 라벨)"

# 원클릭 사용자는 결과를 폴더로 바로 보게 열어준다(테스트 환경 제외).
if ($env:COSMOS_KIT_AUTO -and -not $env:COSMOS_KIT_NO_SCHEDULE) { explorer.exe $Folder }
