# Cosmos 설치 가이드 — 새 조직/개인용

코스모스는 **셀프호스트** 지식 시스템입니다. 조직의 서버(또는 개인 PC) 한 대에 도커로 올리면, 팀의 공용 지식과 각자의 개인 지식(격리)이 3D 코스모스+출처 인용 Q&A로 살아납니다.

## 요구사항

- Docker + Docker Compose
- CPU만으로 동작(임베딩 BGE-M3 CPU 추론). 메모리 4GB+, 디스크는 코퍼스 크기+모델 ~2GB
- **Anthropic API 키** (https://console.anthropic.com — 라벨링·Q&A·다이제스트에 사용)
- (선택) 슬랙 봇 — 초대 DM 자동화용 / GitHub — 개인 지식 레포 커넥터용

## 설치 (10분)

```bash
git clone <cosmos 저장소> && cd cosmos

# 1) 설정 2개 만들기
cp deploy/.env.example deploy/.env          # 필수: COSMOS_TOKEN, COSMOS_PUBLIC_URL, ANTHROPIC_API_KEY
cp cosmos.config.example.json cosmos.config.json   # 수집 피드·워처 경로 (기본값으로도 동작)

# 2) 빌드+기동 (Rust core 빌드에 수 분 — 메모리 작은 서버는 코어 수 제한 권장)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build

# 3) 확인
curl http://localhost:8800/health
```

브라우저에서 `COSMOS_PUBLIC_URL` 접속 → 우측 아래 [관리] 버튼 → `.env`의 COSMOS_TOKEN 입력하면 관리자 화면이 열립니다.

## 첫 지식 넣기

- **회사 공용 문서**: `cosmos.config.json`의 watcher `repo` 소스에 문서 레포 경로를 넣거나, 웹 챗에서 직접 업로드.
- **첫 클러스터 생성**: 문서 수십 건이 들어간 뒤 1회
  `docker compose ... exec mind node dist/cli.js bootstrap` (k-means+LLM 라벨링 자동).
- **외부 수집**(arXiv/RSS): 매일 자동 수집 → **브랜치(검토 대기)** 로 격리 → 웹 관리 화면에서 체리픽 승인. 승인 전에는 답변에 절대 안 섞입니다.

## 팀원 온보딩

1. 관리자: 웹 관리 패널에서 이름 검색→초대(슬랙 봇 설정 시 DM 자동, 아니면 `user add`로 토큰 수동 전달)
2. 팀원: 초대 링크 클릭이면 끝(토큰 자동 저장). 개인 지식은:
   - 지식 레포 템플릿(`COSMOS_TEMPLATE_REPO`)에서 자기 레포 생성 → 웹 [📝 내 지식 연결]에 주소 입력
   - 또는 자기 AI에게: "`<COSMOS_PUBLIC_URL>/web/kit/AI-SETUP.md` 읽고 세팅해줘"
3. 개인 지식은 **본인에게만** 보입니다(무인증·타인 0건 노출). 공유는 지식 PR(브랜치→검토→병합)로.

## 운영 메모

- 재배포: `docker compose ... up -d --build` (데이터는 볼륨에 있어 무손실: cosmos-data/cosmos-mind-data)
- 백업: `docker run --rm -v cosmos-data:/vol -v /backup:/b alpine tar -C /vol -czf /b/cosmos-data.tgz .`
- 공인망 노출 금지 기본: `COSMOS_BIND`를 내부망 IP로 — Docker는 OS 방화벽을 우회해 포트를 엽니다.
- 규격 정본: `contract/CONTRACT.md` 맨 위 "현재 계약 스냅샷".
