# Cosmos — 살아있는 지식 우주 (정본 계획)

> 작성 2026-07-13. 이 문서가 정본. 사용자 확정 결정은 §1, 클로드 표준 디폴트(사후 교정 대상)는 §11.

## 0. 한 줄 정의

**온오퍼 공용 지식 두뇌.** LLM·로보틱스·우주공학·AI 최신 지식과 회사 내부 데이터가 클러스터 단위 온톨로지로 살아 있고, 질문은 관련 클러스터들을 **거쳐서**(불필요하면 건너뛰고) 출처 있는 답으로 조립된다. 클러스터는 고정 분류가 아니라 필요에 따라 태어나고 병합되는 유기체다.

핵심 가치 3가지:
1. **모델이 학습하지 못한 지식으로 답한다** — 최신 논문·발표, 회사 내부 데이터.
2. **답의 경로가 보인다** — 어떤 클러스터를 거쳤고 어떤 클러스터를 왜 건너뛰었는지 궤적(trace)이 답변에 붙는다.
3. **우주가 스스로 자란다** — 유입 지식이 기존 클러스터에 맞지 않으면 새 클러스터가 태어나고, 겹치는 클러스터는 병합된다.

## 1. 확정 결정 (사용자, 2026-07-13)

| # | 항목 | 결정 |
|---|---|---|
| 1 | 용도·사용자 | **회사(온오퍼) 내부 공용 두뇌** — 멀티유저 전제 |
| 2 | 기존 자산 관계 | **완전 신규 설계** (docseal·kcode 코드 미사용, 교훈·검증된 부품 선택은 자유) |
| 3 | 지식 유입 | **3경로 전부** — 자동 수집 파이프라인 + 수동 투입 + 클로드 세션 자동 수확 |
| 4 | 답변 경로 | **클러스터별 에이전트 협의** (deep 모드의 본체) |
| 5 | 데이터 경계 | **Claude API 전면 허용** (회사 데이터 포함, 별도 로컬 티어 없음) |
| 6 | 스택 | **Rust 코어 + TypeScript 오케스트레이션** |
| 7 | 회사 데이터 범위 | 프로젝트 문서·계획 + 메모리·위키 자산 + 코드베이스 + 운영·비즈니스 데이터 (전부) |
| 8 | 협의 빈도 | **기본 즉답(fast) + 명시적 심층(deep) 모드** — deep은 사용자가 켠다 |

## 2. 개념 모델

- **우주(Universe)** = 전체 지식 베이스. 단일 저장소, 단일 저널.
- **클러스터(Cluster)** = 주제 단위 지식 덩어리이자 온톨로지 부분그래프. 자기 색인(벡터+BM25), 자기 개념·관계, 자기 요약(manifest), 자기 중심 벡터(centroid)를 가진다. deep 모드에선 클러스터마다 전문 에이전트가 붙는다.
- **개념(Concept)/관계(Relation)** = 클러스터 내부의 온톨로지 노드·엣지. 근거 청크에 앵커됨.
- **궤적(Trace)** = 질문 하나가 우주를 통과한 기록. `[{cluster, consulted|skipped, 이유}]`. 답변의 1급 구성요소.
- **저널(Journal)** = append-only 이벤트 로그(ingest, cluster_birth, cluster_merge, …). 우주의 모든 변화는 저널을 통해서만 일어나며, 롤백 가능.
- **논문·문서는 소스 타입이지 클러스터가 아니다** — arXiv 논문은 주제에 따라 llm/robotics/space 클러스터로 배정된다. "논문 클러스터"를 따로 두지 않는다.

## 3. 아키텍처

```
                ┌─────────────────────────────────────────────┐
                │  cosmos-mind (TypeScript/Node)               │
 사용자 ───────►│  · 웹 UI(채팅+우주 뷰) · HTTP API · MCP 서버 │
 (웹/MCP/API)   │  · fast 파이프라인: 라우터→연합검색→종합     │
                │  · deep 파이프라인: 플래너→클러스터 에이전트 │
                │    협의→모순검사→종합 (Claude Agent SDK)     │
                │  · 수집기(arXiv/RSS/파일워처) · 세션 수확기   │
                │  · 클러스터 생명주기 데몬(탄생·병합 제안·적용)│
                └──────────────────┬──────────────────────────┘
                                   │ HTTP (OpenAPI 단일 정본)
                ┌──────────────────▼──────────────────────────┐
                │  cosmos-core (Rust, axum)                    │
                │  · 파싱→청킹→임베딩(BGE-M3)→색인             │
                │  · 하이브리드 검색: Tantivy(Lindera)+LanceDB │
                │    RRF→bge-reranker, 클러스터 스코프/연합    │
                │  · 그래프 저장(SQLite): 개념·관계·클러스터   │
                │  · 저널(이벤트 로그) · centroid 통계          │
                └─────────────────────────────────────────────┘
```

**경계 원칙**: LLM 호출은 전부 TS(mind), 결정론적 무거운 일은 전부 Rust(core). core는 LLM을 모르고, mind는 색인 내부를 모른다. 계약은 OpenAPI 스키마 하나로 고정(양쪽 코드젠) — 병렬 개발 시 wire-contract drift 방지(docseal 교훈 [[parallel-agents-wire-contract-drift]]).

**배포**: Rocky 서버(192.168.0.34) Docker compose 2컨테이너(core+mind). LAN 내부 서비스. (M5)

## 4. 데이터 모델 (SQLite 정본 + LanceDB 벡터 + Tantivy 역색인)

```
Doc      {id, source_type(arxiv|rss|manual|session|repo|biz), origin(url|path),
          title, hash, ingested_at, meta_json}
Chunk    {id, doc_id, seq, text, char_start, char_end, section, cluster_ids[]}
Cluster  {id, slug, name, description, status(active|dormant|merged_into:id),
          centroid(LanceDB), sensitivity, created_by(seed|birth), stats_json, updated_at}
Concept  {id, name, aliases[], cluster_ids[], summary, evidence_chunk_ids[]}
Relation {id, src_concept, dst_concept, rel_type, evidence_chunk_ids[], confidence}
Event    {seq, ts, kind(ingest|cluster_birth|cluster_merge|cluster_rename|assign|
          unassign|rollback), payload_json, inverse_json}   ← 저널, 롤백 근거
Query    {id, ts, user, question, mode(fast|deep), trace_json, answer_json, cost_json}
```

- 청크는 **복수 클러스터 소속 가능**(cluster_ids 배열) — 경계 지식이 다리가 된다.
- `inverse_json` = 이벤트를 되돌리는 데 필요한 최소 정보. 병합 롤백은 이걸로 실현.
- Query 테이블 = 사용 로그이자 향후 라우팅 학습 데이터(어떤 클러스터가 실제 유용했나).

## 5. 질의 파이프라인

### 5.1 fast (기본)
1. **라우터**: 질문 임베딩 ↔ 클러스터 centroid 유사도 + BM25 프로브 → 상위 K(디폴트 3) 클러스터 선택, 나머지는 skipped(이유 기록).
2. **연합 검색**: 선택 클러스터들에서 하이브리드 검색(RRF) → 통합 rerank → 상위 N 청크.
3. **종합**: Sonnet 1콜 — 근거 청크만으로 답변 생성, 문장별 출처 번호, 근거 부족 시 `insufficient` 명시(지어내기 금지).
4. 목표 지연 **< 10초**, LLM 1콜.

### 5.2 deep (명시 모드: UI 토글 / `--deep` / MCP 파라미터)
1. **플래너(Opus)**: 질문 분해 → 협의 계획 {참여 클러스터, 순서/병렬, 건너뛰는 클러스터+이유, 하위 질문 배정}.
2. **클러스터 에이전트(Sonnet, 병렬)**: 각자 자기 클러스터 색인·그래프만 도구로 받아 증거 브리프 작성 — `{claims[{text, chunk_refs, confidence}], gaps, contradictions_suspected}`.
3. **모순 검사**: 브리프 간 상충 주장 탐지 → 해당 클러스터 에이전트에 1회 반박/보강 라운드.
4. **종합(Opus)**: 브리프 병합 → 최종 답변 + 주장별 출처 + 신뢰도 + 완전한 궤적.
5. 예상 비용: 질문당 LLM 5~15콜, 수십 초~수 분. **레이트리밋 공유 풀 고려해 동시 deep 1건 직렬화.**

### 5.3 답변 계약 (모드 공통)
```json
{ "answer": "...(문장별 [n] 인용)",
  "sources": [{"n":1, "doc":"...", "origin":"url|path", "chunk":"..."}],
  "trace":   [{"cluster":"llm", "action":"consulted", "why":"centroid 0.82"},
              {"cluster":"space", "action":"skipped", "why":"관련도 미달"}],
  "insufficient": false, "mode":"fast", "cost":{"llm_calls":1,"secs":6} }
```
근거 없는 문장은 출력 금지, 근거 부족은 정직하게 차단 — docseal에서 실증한 안티환각 원칙 승계(단, verbatim 문자열 검증은 v2 옵션, v1은 출처 의무+근거-한정 프롬프트).

## 6. 클러스터 생명주기

- **씨앗(M1)**: 코퍼스 임베딩 군집화(HDBSCAN류) → LLM이 군집 라벨링·기술 → 초기 클러스터 부트스트랩. 수동 지정 아님(§11 씨앗 후보는 참고 프라이어).
- **배정**: ingest마다 라우터가 기존 클러스터 fit 점수 산출 → 임계 이상이면 배정(복수 가능), 미달이면 **misfit 풀**로.
- **탄생(birth)**: misfit 풀에 상호 유사 항목이 N개(디폴트 12) 이상 쌓이면 생명주기 데몬이 새 클러스터 제안 → LLM 명명·기술 → 저널 기록 후 자동 적용.
- **병합(merge)**: centroid 유사도 + 교차 소속 청크 비율이 임계 초과 상태가 2회 연속 점검(일 1회)에서 유지되면 병합 → merged_into 마킹, 색인 통합, 저널에 inverse 기록.
- **휴면(dormant)**: 90일 무조회·무유입 클러스터는 라우팅 우선순위 강등(삭제 아님).
- **거버넌스 디폴트**: **자율 진화 + 저널 + 롤백 + 대시보드/우주 뷰 알림**. 파괴적 연산(클러스터 삭제)만 사람 승인. 모든 생명주기 이벤트는 웹 UI 저널 탭에서 1클릭 롤백.

## 7. 지식 유입 3경로

| 경로 | v1 소스 | 방식 |
|---|---|---|
| 자동 수집 | arXiv(cs.CL·cs.AI·cs.LG·cs.RO·physics.space-ph, §11) + RSS(Anthropic/OpenAI/DeepMind 블로그 등) | 일 1회 크론 → **선별 게이트**(관심 프로파일 매칭, Haiku 요약·점수) 통과분만 ingest — arXiv 홍수 방지 |
| 수동 투입 | 파일·URL·붙여넣기 | 웹 UI 드롭 / `cosmos ingest <path|url>` / MCP `cosmos_ingest` |
| 세션 수확 | 클로드 메모리·전역 위키 **파일 워처** + 프로젝트 `docs/PLAN.md`·설계문서 워처 | 변경 감지 → 증분 재색인. 기존 지식 순환(메모리·위키)이 **정본**, Cosmos는 **파생 색인**(원본 무파괴, kcode와 동일 철학) |

- 코드베이스: 전문 색인이 아니라 **요약·온톨로지 층위**(레포 구조, 공개 API, 핵심 결정) — 수동 트리거 `cosmos ingest --repo <path>`.
- 운영·비즈니스: 어댑터 방식(GA4 리포트 스냅샷, grant-radar 산출물 폴더 워치)부터 시작.
- 중복 방지: Doc.hash 기준 idempotent, 재수집은 증분.

## 8. 스택 디폴트

| 층 | 선택 | 근거 |
|---|---|---|
| core 언어 | Rust, axum + tokio | 멀티유저 동시성. pdfium 같은 !Send 자산 초기 배제로 docseal의 단일스레드 제약 회피 |
| 임베딩 | BGE-M3 (fastembed/ort, 1024d) | docseal에서 한국어·교차언어 검증 완료 |
| 리랭커 | bge-reranker-v2-m3 | 〃 |
| BM25 | Tantivy + Lindera(한국어) + sanitize_query | 〃 (자연어 구두점 크래시 교훈 선반영) |
| 벡터 | M0~M1: SQLite BLOB + 브루트포스 코사인(`VectorStore` 트레이트 뒤) → M2+ LanceDB 승격 | 씨앗 규모(수천 청크)엔 브루트포스가 손실 0·수 ms(docseal 실증), 무거운 arrow 빌드체인은 arXiv 볼륨 붙는 M2로 연기 |
| 정본 DB | SQLite(rusqlite) | 단일 파일, 백업 쉬움 |
| mind | Node 22 + TypeScript + Claude Agent SDK | 에이전트 협의·수집기·MCP |
| 모델 라우팅 | 플래너·deep종합=Opus / 클러스터 에이전트·fast종합=Sonnet / 수집 선별·요약=Haiku | 비용-품질 균형 |
| 웹 UI | React + Vite (mind가 서빙) | 채팅 + 우주 뷰(그래프) + 저널 |
| 계약 | OpenAPI 스키마 → 양쪽 타입 생성 | drift 방지 |
| 배포 | Docker compose @ Rocky | 회사 내부 LAN |

파싱 v1 범위: **md·txt·html·pdf(텍스트층)** — HWP·OCR·스캔은 비목표(docseal 영역, 필요 시 후순위).

## 9. 마일스톤

| M | 내용 | 게이트(증거) |
|---|---|---|
| **M0** | 레포 스캐폴드, OpenAPI 계약, core: ingest→청킹→임베딩→하이브리드 검색→SQLite/Tantivy/벡터(BLOB), 저널 골격 | 씨앗 코퍼스(전역 위키 84p+메모리) 색인, 검증 질의셋 hit@6 확인, 앵커 불일치 0 |
| **M1** | 클러스터 부트스트랩(군집화+LLM 라벨) + fast Q&A(CLI/HTTP) + 궤적 trace | 10문항: 출처 있는 정답 + 코퍼스 밖 3문항 insufficient 차단 + trace에 skipped 이유 표시 |
| **M2** | 유입 3경로 — arXiv/RSS 수집기(선별 게이트), 수동 ingest, 메모리·위키 파일 워처 | 오늘 나온 논문이 내일 질의에 출처로 등장(종단 실증), 워처 증분 재색인 동작 |
| **M3** | deep 모드 — 플래너→클러스터 에이전트 협의→모순검사→종합 (Agent SDK) | 교차 클러스터 질문 5개에서 fast 대비 우위 A/B(누락 근거 회수·모순 지적), 궤적 완전 기록 |
| **M4** | 생명주기 — misfit→탄생, 병합 판정, 저널 롤백, 우주 뷰 UI(클러스터 그래프+궤적 시각화) | 이질 코퍼스 투입→클러스터 자동 탄생 실증, 병합 1건 실행→롤백 왕복 무손실 |
| **M5** | 팀 배포 — Docker compose @ Rocky, 간단 토큰 인증, MCP 서버 정식화, 사용 로그 | 두 사용자 동시 질의, 타 클로드 세션에서 MCP로 cosmos_ask 동작 |
| **M6** | Knowledge Hub 편입 — 소스 모델(docs_only/include_meta) 16소스, PC→Rocky 일일 동기화(윈도우 스케줄러) | 프로젝트 정본 문서 질의가 PLAN/설계 문서 인용, RESULTS.md 인제스트 0 |
| **M7** | 전역(열거형) 질문 — frontmatter 엔티티 레지스트리 + 인텐트 게이트 + 클러스터 다이제스트(GraphRAG global search) | "프로젝트 전체 현황" 질의가 레지스트리 전수(이름 ≥90%) 커버·환각 0, point 질문 무회귀 |
| **M7.5** | 웹 챗 UI + 진행 스트림 — /ask/stream SSE(실단계 status), 채팅 스레드·타자기·mode 뱃지 | 라이브 스트림 실측, 스크린샷 육안, 기존 /ask·MCP 무회귀 |
| **M8** | 지식 PR — 브랜치·머지(체리픽+롤백) + 관리자/사용자 역할(개인 토큰) + 수집 일원화(인박스→브랜치) + 웹 검토 화면 | 브랜치 격리(main 질의 미노출), member merge 403, 머지 롤백 왕복 무손실, 생명주기 브랜치 무시 |
| **M9** | 지식 소유권 — 공통/개인 분리(docs·clusters.owner), 스코프 질의, 개인 클러스터 재부트스트랩, 승격=지식 PR 재사용 | 타인·무인증에 개인 지식 0 노출, admin 전체현황 28/28 유지, 승격·롤백 왕복(owner 복원) |

작업 방식(기존 directive 승계): 관리·설계·리뷰·게이트 검증=본체(Fable), 코드 구현=Sonnet(executor), 자기승인 금지·리뷰 별도 패스.

## 10. 리스크

1. **deep 협의 비용·레이트리밋** — kcode에서 주간 한도 실경험. 완화: deep은 명시 모드 한정(확정), 동시 1건 직렬화, Query.cost 로깅으로 가시화.
2. **클러스터 자동 병합 폭주/진동** — 완화: 2회 연속 점검 히스테리시스, 저널 롤백, 병합 임계 보수적.
3. **arXiv 잡음 유입** — 완화: 선별 게이트(관심 프로파일)와 dormant 강등. 수집량보다 라우팅 정확도가 우선.
4. **이중 스택 계약 드리프트** — 완화: OpenAPI 단일 정본 + 계약 테스트.
5. **정본 이원화**(메모리·위키 vs Cosmos) — 완화: Cosmos는 항상 파생 색인, 원본 무파괴, origin 경로 보존.
6. **회사 데이터 민감도** — Claude API 전면 허용은 사용자 확정. 단 Cluster.sensitivity 필드는 스키마에 남겨 향후 하이브리드 전환 여지 확보.

## 11. 표준 디폴트 목록 (사후 교정 대상 — "진행"이면 이대로 감)

- 씨앗 클러스터 프라이어: llm / ai-research / robotics / space / onoffer-projects / onoffer-biz (실제 씨앗은 M1 군집화 결과가 우선, 이 목록은 라벨링 힌트)
- arXiv 카테고리: cs.CL, cs.AI, cs.LG, cs.RO, physics.space-ph · 수집 주기: 일 1회 · 선별 임계: 프로파일 매칭 상위 20편/일
- fast 라우팅 K=3 클러스터, 최종 근거 N=8청크 · misfit 탄생 임계 N=12 · 병합 점검 일 1회
- 포트: core 8801, mind 8800 · 인증: M4까지 LAN 무인증, M5 공유 토큰
- 우주 뷰: force-directed 그래프(클러스터=노드 크기∝청크수, 질의 시 궤적 하이라이트)
- verbatim 인용 검증(docseal식)은 v2 백로그 · HWP/OCR 비목표
- 레포: D:\cosmos (git init, 커밋은 게이트 통과 시)
