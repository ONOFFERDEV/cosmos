# Cosmos — 살아있는 지식 코스모스

팀의 지식이 클러스터(주제 단위 온톨로지)로 살아 있고, 질문은 클러스터들을 거쳐(불필요하면 건너뛰고) **출처 + 경유 궤적(trace)** 이 붙은 답으로 조립되는 **셀프호스트 지식 시스템**입니다.

- **공통/개인 분리** — 팀 공용 지식과 각자의 개인 지식이 격리(무인증·타인에게 0건 노출), 개인→공용은 지식 PR로 승격
- **개인 지식 = 각자의 GitHub 레포** — 레포에 .md를 push하면 서버가 pull(PC 설치물 0), AI 실행용 셋업 런북 내장
- **지식 PR** — 외부 수집(arXiv/RSS)은 브랜치로 격리 → 관리자 검토·체리픽 병합, 저널 롤백 왕복 무손실
- **3D 코스모스 뷰** + 실시간 진행 표시 챗(fast/deep/global 모드) + MCP 브리지
- 스택: `core/`(Rust — 색인·하이브리드 검색·클러스터·저널) + `mind/`(TS — LLM 파이프라인·인증·수집·웹) — LLM은 Anthropic API

## 라이선스

**FSL-1.1-Apache-2.0** (source-available — 오픈소스가 아닌 소스 공개 라이선스입니다). 내부 사용·자체 호스팅은 개인·기업 모두 자유이며, 코스모스와 경쟁하는 상용 서비스 제공만 제한됩니다. 각 릴리스는 **2년 후 Apache-2.0으로 자동 전환**됩니다. 전문: `LICENSE.md`

## 시작하기

- **새 조직/개인 설치**: `docs/SETUP.md` (도커 1대, 10분)
- **팀원 가이드**: `docs/TEAM-KNOWLEDGE.md` · **규격 정본**: `contract/CONTRACT.md` 맨 위 "현재 계약 스냅샷" + `contract/openapi.yaml`
- **설계 배경**: `docs/PLAN.md` · **AI 작업 가이드**: `CLAUDE.md`

## 로컬 개발

```bash
cd core && cargo test                      # Rust 엔진 (ignored 테스트는 -- --ignored, 모델 캐시 필요)
cd mind && npm test                        # TS 전체
node mind/dist/cli.js serve --port 8807    # 로컬 서버 → http://localhost:8807/?fixture=1 (샘플 데이터 3D 뷰)
```

---

## 온오퍼 운영 메모 (자체 배포분)

- 접속: **http://192.168.0.34:8800** (LAN) · 헬스: `curl http://192.168.0.34:8800/health`
- 상태: `ssh onofferserver "docker ps --format '{{.Names}} {{.Status}}' | grep deploy-"`
- 팀원 초대: 웹 관리 패널(이름 검색→봇 DM) 또는 `docker exec deploy-mind-1 node dist/cli.js invite <이름> <슬랙ID>`
- 관리자 PC→코스모스 일일 동기화: Windows 스케줄러 `CosmosHubSync`(09:23, `tools/sync-hub.ps1`)
- 재배포: 이미지 **로컬 빌드** 후 `docker save | ssh docker load` (Rocky 서버 빌드 금지 — `CLAUDE.md` 참고)
