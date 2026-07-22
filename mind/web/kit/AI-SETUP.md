# [AI 실행용] 코스모스 개인 지식 레포 세팅 런북

> 이 문서는 팀원의 AI 에이전트(클로드 코드 등)가 읽고 그대로 실행하기 위한 런북이다.
> 목표: 사용자의 개인 지식 GitHub 레포를 만들고, 코스모스({{PUBLIC_URL}})에 연결해,
> 레포에 쓰는 .md 노트가 사용자의 개인 공간에 자동 반영되게 한다.
> 결과는 사용자에게만 보인다(무인증·다른 팀원에게 0건 노출).

## 실행 규칙 (AI는 반드시 지킬 것)

- 아래 값 2개가 필요하다. 없으면 **먼저 사용자에게 물어라**:
  - `NAME` — 코스모스 계정 이름(초대받은 한글 이름, 예: 철수). 모르면 3단계의 /me 호출이 알려준다.
  - `COSMOS_TOKEN` — 초대 DM으로 받은 코스모스 토큰.
- 토큰(코스모스·GitHub 모두)은 **채팅·로그에 출력하지 말고** 셸 변수/파일로만 다뤄라.
- 각 단계의 **검증을 통과하기 전에는 다음 단계로 가지 마라.** 실패 시 이 문서의 분기 지침을 따르고, 없으면 사용자에게 상황을 보고하라.
- 명령은 Windows PowerShell 기준이다(mac/linux면 동등 명령으로 치환).

## 0단계 — 사전 점검

```powershell
gh --version        # 없으면: winget install GitHub.cli 후 재시도
gh auth status      # "Logged in" 없으면: gh auth login (사용자에게 브라우저 인증 요청)
```

## 1단계 — 코스모스 인증 확인 + 이름 획득

```powershell
$env:COSMOS_TOKEN = '<사용자에게 받은 토큰>'   # 채팅에 다시 출력 금지
irm {{PUBLIC_URL}}/me -Headers @{ Authorization = "Bearer $env:COSMOS_TOKEN" }
```
- 검증: `name`(=NAME으로 사용)과 `role`이 나온다. 401이면 토큰이 잘못됐거나 폐기됨 → 사용자에게 재발급(관리자 문의) 요청.

## 2단계 — 지식 레포 생성 (템플릿에서)

**A안(우선): 템플릿과 같은 org에 생성** — 성공하면 코스모스가 토큰 없이 읽을 수 있어 가장 간단하다.
```powershell
gh repo create "{{TEMPLATE_ORG}}/knowledge-<NAME>" --template {{TEMPLATE_REPO}} --private
```
- 성공 → `REPO = {{TEMPLATE_ORG}}/knowledge-<NAME>` 로 두고 4단계로.
- 403/404(권한 없음) → B안으로.

**B안(폴백): 본인 계정에 private 생성**
```powershell
$me = gh api user --jq .login
gh repo create "$me/my-knowledge" --template {{TEMPLATE_REPO}} --private
```
- `REPO = <본인아이디>/my-knowledge`. **B안은 3단계(PAT)가 추가로 필요하다.**

- 공통 검증: `gh repo view $REPO --json name` 이 성공해야 한다.

## 3단계 — (B안일 때만) 읽기 전용 PAT 발급

이 단계는 GitHub 웹에서만 가능하다 — **사용자에게 다음을 정확히 안내하고 결과 토큰을 받아라**:
1. https://github.com/settings/personal-access-tokens/new 접속
2. Token name: `cosmos-knowledge-read` / Expiration: 1년
3. Repository access: **Only select repositories** → 방금 만든 레포만 선택
4. Permissions → Repository permissions → **Contents: Read-only** (그 외 전부 No access)
5. Generate 후 토큰을 AI에게 전달(채팅 기록이 남는 매체라면 파일로)

받은 값을 `GH_PAT` 변수에 담는다. A안이면 이 단계 전체를 건너뛴다.

## 4단계 — 코스모스에 연결 (즉시 1회 동기화 포함)

```powershell
$body = @{ repo = "<REPO>" }
if ($env:GH_PAT) { $body.token = $env:GH_PAT }   # B안일 때만
$json = $body | ConvertTo-Json
irm {{PUBLIC_URL}}/my/repo -Method Put `
  -Headers @{ Authorization = "Bearer $env:COSMOS_TOKEN" } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
```
- 검증: 응답 `saved=true` 이고 `sync.ingested`가 **2 이상**(템플릿의 README+시작하기). `sync.error`가 있으면:
  - `GitHub 404` → 레포 주소 오타 또는 접근 불가(B안인데 PAT 누락/스코프 부족) → 3단계 재확인.
  - 그 외 → 오류 메시지 그대로 사용자에게 보고.

## 5단계 — 최종 검증 (왕복)

```powershell
# ① 연결 상태
irm {{PUBLIC_URL}}/my/repo -Headers @{ Authorization = "Bearer $env:COSMOS_TOKEN" }
# ② 실제 반영: 노트 하나 추가 후 push → 즉시 동기화 → 검색 확인
$probe = "e2e-" + (Get-Date -Format yyyyMMddHHmm)
gh api "repos/<REPO>/contents/$probe.md" -X PUT -f message="세팅 검증" `
  -f content=([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("# 세팅 검증`n$probe 프로브")))
irm {{PUBLIC_URL}}/my/repo/sync -Method Post -Headers @{ Authorization = "Bearer $env:COSMOS_TOKEN" }
$r = irm {{PUBLIC_URL}}/search -Method Post -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $env:COSMOS_TOKEN" } -Body ('{"query":"' + $probe + ' 프로브","k":5}')
$r.results | Select-Object -First 3 origin
```
- 검증: sync 응답 `changed=true`, 검색 결과에 `knowledge://<NAME>/<probe>.md`가 보이면 **성공**.
- 프로브 파일은 남겨도 무해하지만, 지우고 싶으면 레포에서 삭제해도 된다(코스모스의 색인은 남는 v1 한계 — 무해).

## 6단계 — 사용자에게 보고할 것 (이 형식으로)

- 레포 주소와 (A안/B안 중) 택한 경로
- "이제 이 레포에 .md를 쓰고 push하면 1시간 내 자동 반영, 급하면 코스모스 화면 아래 [📝 내 지식 연결] 패널의 [지금 동기화]"
- 노트 작성 요령: 파일 하나=지식 하나, 첫 줄 `# 제목`. `.`폴더와 비-md는 무시됨
- 웹 확인법: {{PUBLIC_URL}} (본인 성운 = "개인 · " 라벨 + 점선 링)
- 팀과 공유하고 싶은 문서가 생기면 관리자에게 승격 요청

## 부록 — 이 런북이 하는 일의 구조 (AI 참고용)

- 정본=사용자의 레포. 코스모스 서버가 1시간마다 head sha를 보고 변경 시에만 tarball을 받아 반영한다(중복·재전송 걱정 없음).
- 연결 정보는 서버의 repos.json에 저장되며 owner는 코스모스 identity로 강제된다(타인 공간에 등록 불가).
- 같은 노트를 다른 경로(로컬 폴더 동기화 등)로 이중 연결하지 마라 — origin이 달라 중복 문서가 된다.
