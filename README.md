# Cosmos — 살아있는 지식 코스모스

팀의 지식이 클러스터(주제 단위 온톨로지)로 살아 있고, 질문은 클러스터들을 거쳐(불필요하면 건너뛰고) **출처 + 경유 궤적(trace)** 이 붙은 답으로 조립되는 **셀프호스트 지식 시스템**입니다.

- **공통/개인 분리** — 팀 공용 지식과 각자의 개인 지식이 격리(무인증·타인에게 0건 노출), 개인→공용은 지식 PR로 승격
- **개인 지식 = 각자의 GitHub 레포** — 레포에 .md를 push하면 서버가 pull(PC 설치물 0), AI 실행용 셋업 런북 내장
- **지식 PR** — 외부 수집(arXiv/RSS)은 브랜치로 격리 → 관리자 검토·체리픽 병합, 저널 롤백 왕복 무손실
- **3D 코스모스 뷰** + 실시간 진행 표시 챗(fast/deep/global 모드) + MCP 브리지
- 스택: `core/`(Rust — 색인·하이브리드 검색·클러스터·저널) + `mind/`(TS — LLM 파이프라인·인증·수집·웹) — LLM은 Anthropic API

## 라이선스

**MIT** — 오픈소스입니다. 개인·기업 누구나 자유롭게 사용·수정·배포·상용화할 수 있습니다. 전문: `LICENSE.md`

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
