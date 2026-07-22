# my-knowledge.ps1 — 코스모스 개인 지식 킷 (팀원 자가완결 스크립트)
#
# 개인 노트(.md)를 코스모스의 "내 개인 공간"으로 동기화한다. 개인 지식은 본인에게만
# 보이고(무인증·타인에게 0 노출), 공유하고 싶은 문서는 관리자에게 승격을 요청한다.
#
# 사용법:
#   .\my-knowledge.ps1 -Init -Token <내토큰>     # 최초 1회: 폴더+git+샘플 생성, 토큰 저장
#   .\my-knowledge.ps1 -Sync                     # 노트 전체 동기화(중복은 서버가 무료로 걸러냄)
#   .\my-knowledge.ps1 -Schedule                 # 매일 09:37 자동 동기화 등록
#
# 기본 폴더: %USERPROFILE%\cosmos-knowledge  (-Folder 로 변경 가능)
# 이 스크립트는 -Init 시 폴더 안으로 자기 복제되므로, 받은 파일 하나로 시작하면 된다.
param(
  [switch]$Init,
  [switch]$Sync,
  [switch]$Schedule,
  [string]$Folder = "$env:USERPROFILE\cosmos-knowledge",
  [string]$Url = "{{PUBLIC_URL}}",
  [string]$Token = ""
)

$ErrorActionPreference = 'Stop'
$tokenFile = Join-Path $Folder '.cosmos-token'

function Resolve-Token {
  if ($Token) { return $Token }
  if ($env:COSMOS_TOKEN) { return $env:COSMOS_TOKEN }
  if (Test-Path $tokenFile) { return (Get-Content $tokenFile -Raw -Encoding UTF8).Trim() }
  throw "토큰이 없습니다. -Token <토큰> 으로 실행하거나 초대 DM의 토큰을 $tokenFile 에 저장하세요."
}

function Get-Me([string]$tok) {
  try {
    return Invoke-RestMethod -Uri "$Url/me" -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 15
  } catch {
    throw "코스모스 인증 실패($Url/me): 토큰을 확인하세요. ($($_.Exception.Message))"
  }
}

# PS 5.1의 ConvertTo-Json은 단일 원소 배열을 스칼라로 붕괴시키므로 docs 배열은 수동 조립한다.
function Send-Batch([string]$tok, [string]$owner, [object[]]$docs) {
  $docsJson = ($docs | ForEach-Object { $_ | ConvertTo-Json -Depth 4 -Compress }) -join ','
  $ownerJson = $owner | ConvertTo-Json
  $body = '{"owner":' + $ownerJson + ',"docs":[' + $docsJson + ']}'
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  return Invoke-RestMethod -Method Post -Uri "$Url/ingest" `
    -Headers @{ Authorization = "Bearer $tok" } `
    -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 600
}

if ($Init) {
  New-Item -ItemType Directory -Force $Folder | Out-Null
  $tok = Resolve-Token
  $me = Get-Me $tok
  Set-Content -Path $tokenFile -Value $tok -Encoding Ascii
  Set-Content -Path (Join-Path $Folder '.gitignore') -Value ".cosmos-token" -Encoding Ascii

  $sample = Join-Path $Folder 'welcome.md'
  if (-not (Test-Path $sample)) {
    # UTF-8(BOM 없이) 기록 — PS5.1 Set-Content -Encoding UTF8은 BOM을 붙이므로 .NET API 사용.
    [System.IO.File]::WriteAllText($sample, @"
# $($me.name)의 코스모스 개인 지식

이 폴더의 모든 .md 파일이 코스모스의 "내 개인 공간"으로 동기화됩니다.
- 나에게만 보입니다(무인증·다른 팀원에게 0 노출).
- 파일 하나 = 지식 하나. 첫 줄 ``# 제목``이 문서 제목이 됩니다.
- 동기화: ``.\my-knowledge.ps1 -Sync`` (또는 -Schedule 로 매일 자동).
- 팀 전체와 공유하고 싶은 문서가 생기면 관리자에게 승격을 요청하세요.
"@, (New-Object System.Text.UTF8Encoding($false)))
  }

  # 자기 복제(팀원은 파일 하나만 받으면 됨) + git 초기화(선택적 백업용)
  $self = $MyInvocation.MyCommand.Path
  $dest = Join-Path $Folder 'my-knowledge.ps1'
  if ($self -and ($self -ne $dest)) { Copy-Item $self $dest -Force }
  if (Get-Command git -ErrorAction SilentlyContinue) {
    if (-not (Test-Path (Join-Path $Folder '.git'))) {
      git -C $Folder init -b main | Out-Null
      git -C $Folder add -A; git -C $Folder commit -m "개인 지식 시작" | Out-Null
    }
  }

  Write-Output "초기화 완료: $Folder  (인증: $($me.name) / $($me.role))"
  Write-Output "다음: 노트를 쓰고  .\my-knowledge.ps1 -Sync  를 실행하세요."
  Write-Output "원격 백업(선택): gh repo create my-knowledge --private --source `"$Folder`" --push"
  return
}

if ($Sync) {
  if (-not (Test-Path $Folder)) { throw "폴더가 없습니다: $Folder (먼저 -Init)" }
  $tok = Resolve-Token
  $me = Get-Me $tok
  $owner = if ($me.role -eq 'admin') { 'admin' } else { $me.name }

  $files = Get-ChildItem $Folder -Recurse -File -Filter *.md | Where-Object { $_.FullName -notmatch '\\\.git\\' }
  if (-not $files) { Write-Output "동기화할 .md 파일이 없습니다: $Folder"; return }

  $docs = foreach ($f in $files) {
    # Get-Content -Raw의 문자열은 ETS 프로퍼티가 붙어 ConvertTo-Json이 {"value":...} 객체로
    # 직렬화하는 지뢰가 있다 — .NET ReadAllText(순수 string, UTF-8 BOM 유무 자동)로 읽는다.
    $text = [System.IO.File]::ReadAllText($f.FullName)
    if (-not $text -or -not $text.Trim()) { continue }
    $rel = $f.FullName.Substring($Folder.TrimEnd('\').Length + 1) -replace '\\', '/'
    $titleLine = ($text -split "`n" | Where-Object { $_ -match '^#\s+' } | Select-Object -First 1)
    $title = if ($titleLine) { ($titleLine -replace '^#\s+', '').Trim() } else { $f.BaseName }
    # origin은 전사 유일해야 하므로 파일 경로가 아니라 knowledge://<이름>/<상대경로> 네임스페이스를 쓴다.
    @{ origin = "knowledge://$owner/$rel"; source_type = 'session'; title = $title; text = $text }
  }

  $total = 0; $dup = 0; $failed = 0
  for ($i = 0; $i -lt $docs.Count; $i += 50) {
    $batch = @($docs)[$i..([Math]::Min($i + 49, $docs.Count - 1))]
    $resp = Send-Batch $tok $owner $batch
    foreach ($r in $resp.ingested) {
      $total++
      if ($r.duplicate) { $dup++ }
    }
  }
  Write-Output "동기화 완료: $total 건 (무변경 $dup, 신규/갱신 $($total - $dup)) — 코스모스($Url)의 내 공간에 반영됨"
  return
}

if ($Schedule) {
  $dest = Join-Path $Folder 'my-knowledge.ps1'
  if (-not (Test-Path $dest)) { throw "먼저 -Init 을 실행하세요 (스크립트가 $dest 에 있어야 합니다)." }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dest`" -Sync -Folder `"$Folder`" -Url `"$Url`""
  $trigger = New-ScheduledTaskTrigger -Daily -At 09:37
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
  Register-ScheduledTask -TaskName 'CosmosMyKnowledge' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Output "등록 완료: 매일 09:37 자동 동기화 (작업 이름 CosmosMyKnowledge)"
  return
}

Write-Output "사용법: -Init -Token <토큰> | -Sync | -Schedule   (기본 폴더 $Folder)"
