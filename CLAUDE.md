# Cosmos — AI 작업 가이드

온오퍼 공용 "살아있는 지식 코스모스". 지식이 클러스터(주제 온톨로지)로 살아 있고, 질문은 클러스터를 경유해 **출처+궤적(trace)** 붙은 답으로 조립된다. 제품 텍스트·대화에서 호칭은 항상 **"코스모스"**(코드 식별자 `/universe`는 유지).

## 처음이라면 이 순서로 읽어라

1. `contract/CONTRACT.md` 맨 위 **"현재 계약 스냅샷"** — 지금 유효한 규격 통합본 (그 아래 M0~M9 절은 결정 이유 히스토리)
2. `contract/openapi.yaml` — HTTP API 정본
3. `docs/PLAN.md` — 왜 이렇게 만들었는지(확정 결정·개념 모델)
4. 코드는 아래 지도에서 필요한 파일만 — **engine.rs류 대형 파일 통독 금지**(아래 규율)

## 모듈 지도

| 영역 | 위치 | 내용 |
|---|---|---|
| 색인·검색 엔진 | `core/src/engine/` | ingest(데이터 넣기)·search(검색)·clusters·lifecycle·branches(지식 PR·승격)·rollback — 파일명이 곧 관심사 |
| 저장 계층 | `core/src/store.rs` | SQLite DDL·마이그레이션·쿼리 |
| HTTP(core) | `core/src/serve.rs` | axum 라우트 테이블(:8801, 내부망 전용) |
| 질의 파이프라인 | `mind/src/ask.ts`(fast) `deep.ts`(협의) `global.ts`(전수 열거) `intent.ts`(모드 분류) | LLM은 전부 mind에만 있다 |
| 유입 | `mind/src/collect.ts`(수집→브랜치) `watcher.ts`(일일 동기화) | |
| 인증·역할 | `mind/src/users.ts` `invite.ts` | 인증 경계는 mind — core는 owner_scope를 신뢰 |
| 클러스터 운영 | `mind/src/bootstrap.ts`(라벨링) `lifecycle.ts` `digest.ts` | |
| HTTP(mind) | `mind/src/server.ts` | :8800 LAN, 웹 서빙+프록시+SSE |
| 웹 | `mind/web/` | scene.js(3D 렌더만)·app.js(부트스트랩)·ask.js(챗)·review.js(관리 콘솔) — 각 파일 첫 줄 주석이 경계 정의 |

## 명령어

```bash
# core: 빌드·테스트 (테스트 79개 = 67 + ignored 12(fastembed 모델 필요))
cd core && cargo test 2>&1 | tail -5; echo EXIT=${PIPESTATUS[0]}
cargo test --lib -- --ignored 2>&1 | tail -5          # 네트워크/모델 의존분

# mind: 빌드+테스트 171개
cd mind && npm test 2>&1 | tail -8

# 로컬 웹 확인 (fixture 모드 — 실데이터 불요, window.__cosmosSceneApi 테스트 훅 활성)
node mind/dist/cli.js serve --port 8807   # → http://localhost:8807/?fixture=1

# 배포 (Rocky 서버 빌드 금지 — -j32 하드행. 반드시 로컬 빌드→직렬 전송)
docker build -f deploy/Dockerfile.core -t cosmos-core:latest .
docker build -f deploy/Dockerfile.mind -t cosmos-mind:latest .
docker save cosmos-mind:latest | gzip | ssh <운영서버> "gunzip | docker load"
ssh <운영서버> "cd ~/cosmos && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d"
curl -fsS <공개주소>/health   # COSMOS_BIND를 LAN IP로 제한한 배포는 127.0.0.1로 안 잡힌다
# 실제 서버 주소·계정 등 배포처별 값은 CLAUDE.local.md(로컬 전용, git 미추적)를 본다.
```

## 작업 규율 (실사고에서 나온 규칙 — 지키면 산다)

- **대형 파일 통독 금지**: engine 모듈·store.rs·server.ts는 Grep으로 좌표를 잡고 그 구간만 Read(offset/limit). 서브에이전트가 이 파일들을 통독하다 컨텍스트 폭주로 9회 사망했다.
- **파이프 뒤 exit 확인**: `cmd | tail`은 실패를 삼킨다 — `echo EXIT=${PIPESTATUS[0]}` 필수(구 바이너리 배포 직전까지 간 사고 이력).
- **게이트는 실경로로**: 인증·스코프 검증의 최종 게이트 1개는 API 직접 호출이 아니라 헤드리스 브라우저(실제 웹 fetch 경로)로. 라이브 E2E는 생성 부산물(자동 탄생 클러스터 등 파생 구조 포함)을 역추적 정리하고 전후 /health 카운트 diff로 확인.
- **파괴 연산 리허설**: 마이그레이션·클러스터 재생성은 실DB 사본에서 먼저(볼륨 docker cp → 로컬 리허설 → Rocky 적용). 적용 전 볼륨 tar 백업.
- **데이터 격리**: `data/`, `deploy/.env`, `.mcp.json`은 gitignore 유지(토큰 포함). 토큰 문자열을 채팅·로그에 출력하지 않는다.
- **계약 우선**: 규격 변경은 CONTRACT 스냅샷+openapi를 먼저 고치고 구현. 몰래 편차 금지(RESULTS.md에 기록).
- 지식 기록은 상대 평가어 대신 **측정값+조건+비교 기준**(예: "fast ask 13~16s, Rocky, 로컬 30~123s 대비").

## 검증 게이트 (변경 유형별 최소선)

| 변경 | 게이트 |
|---|---|
| core | `cargo test` 전량 + ignored, 스코프/브랜치 격리 테스트 무회귀 |
| mind | `npm test` 171 전량 |
| web | fixture 헤드리스(문법+DOM+`__cosmosSceneApi` 어서션)+스크린샷 육안 1장 |
| 배포 | /health 카운트 확인(문서 240·클러스터 19 기준선, 2026-07-22) + 무인증/admin 스코프 각 1프로브 |
