# Cosmos 계약 — core ↔ mind ↔ tools 단일 정본

> HTTP API 스키마는 `openapi.yaml`이 정본. 이 문서는 API 밖의 합의(포트·파일 레이아웃·상수·DDL·게이트)를 고정한다.
> 충돌 시 우선순위: CONTRACT.md ≥ openapi.yaml > 각 구현. 구현이 계약을 못 지키면 계약을 몰래 바꾸지 말고 RESULTS.md에 편차를 기록할 것.
> **문서 구조**: 바로 아래 "현재 계약 스냅샷"이 지금 유효한 규격의 통합본이다. 그 뒤의 `# M0`~`# M9 확장` 절들은 결정 이유·게이트 기록이 담긴 히스토리 — 규격이 충돌하면 스냅샷(=최신 마일스톤)이 이긴다.

# 현재 계약 스냅샷 (M9까지 반영, 2026-07-22)

## 구성
- **core**(Rust, :8801, 컨테이너 내부망 전용) = 결정론 전부: 파싱·청킹·임베딩·하이브리드 검색·클러스터·저널·브랜치. LLM 코드 0.
- **mind**(TS, :8800, LAN 바인딩) = LLM·인증·오케스트레이션 전부: 질의 파이프라인, 수집기, 워처, 사용자/초대, 웹 UI 서빙, MCP.
- **web**(mind/web/, 순수 정적) = 3D 코스모스 뷰 + 챗 + 관리 콘솔. 호칭은 항상 "코스모스"(코드 식별자 /universe는 유지).

## 데이터 모델 (SQLite, 마이그레이션 누적 반영)
- `docs(id, source_type, origin UNIQUE, title, hash, n_chars, ingested_at, meta_json, branch_id NULL=main, owner NULL=공통)`
- `chunks(id, doc_id, seq, text, char_start/end, section, cluster_ids JSON, embedding BLOB)` — 앵커 불변식은 M0 절
- `clusters(id, slug UNIQUE, name, description, status active|dormant|merged, centroid BLOB, updated_at, owner NULL=공통)`
- `branches(id, name UNIQUE, status open|merged|discarded, created_by, created_at, merged_at)` — n_docs는 조회 시 COUNT
- `entities(doc_id, kind, name, payload_json)` — frontmatter 파생 레지스트리(ingest·duplicate 시 upsert, 저널 무기록)
- `cluster_digests(cluster_id, text, model, updated_at)` — GraphRAG형 클러스터 자기소개문
- `events(seq, ts, kind, payload_json, inverse_json)` — 저널. inverse 있는 kind만 /rollback 지원
- concepts/relations는 예약(미사용)

## 검색·라우팅 (읽기 경로 공통 규칙)
- search = sanitize_query → BM25 top20 + 벡터 top20 → **exclusion-set 필터** → RRF(k=60, pool 16) → bge-reranker → top 6
- **exclusion-set = `(branch_id IS NULL OR =include_branch_id) AND (owner IS NULL OR =scope owner)`** — 재색인 없이 후보 단계에서 격리. search/route/misfits/docs/clusters/entities/digests/centroids/universe/lifecycle **전 읽기 경로** 적용.
- **owner_scope** = `"shared"`(공통만) | `"shared+<name>"`(공통+해당 개인). **인증 경계는 mind**: identity→스코프(admin→shared+admin, member→shared+<이름>, 무인증→shared), 공개 경로는 클라이언트가 보낸 owner_scope를 **서버 계산값으로 무조건 덮어씀**(위장 차단). core는 mind가 준 값을 신뢰.

## 지식 유입 (3경로) · 지식 PR · 승격
- **수집(collect)**: arXiv+RSS 결정론 점수 상위분 → 자동 브랜치 `collect/YYYY-MM-DD`(완전 격리) → 웹 검토 화면에서 admin 체리픽 병합/거부. 인박스는 폐지(/inbox=410).
- **워처(scan)**: PC 일일 동기화(배포처별 스케줄러, 온오퍼는 일 1회) — session 소스(메모리·위키)→`owner=admin` 개인, repo 소스(정본 문서)→공통. main 직행(자기 지식은 검토 불요).
- **manual**: 직행. member 업로드는 branch_id 또는 owner=본인 중 하나 필수(403).
- **ingest 배정**: argmax centroid(owner 문서는 owner 일치 클러스터만), fit<0.5→low_fit. owner+branch_id 동시 지정=400. 첫 개인 문서는 `personal-<name>` 클러스터 자동 탄생.
- **승격(개인→공통)**: `POST /branches/{id}/docs {doc_ids}`(owner≠NULL만, all-or-nothing) → merge 시 branch_id=NULL+owner=NULL, inverse에 doc별 이전 owner → rollback이 소유권까지 복원. discard는 비가역(origins만 저널).

## 질의 (mind)
- 모드: **fast**(라우팅 K=3→스코프 검색→LLM 1콜→결정적 봉투 조립) / **deep**(플래너 Opus→클러스터 에이전트 Sonnet 동시 2→모순 1라운드→종합) / **global**(엔티티 전수+다이제스트 전수+search k=6 병합 — 열거형 질문 전용) / auto=인텐트 게이트 결정론 분류.
- 봉투 = answer+sources+trace(consulted/skipped+이유)+insufficient(근거 부족 시 정직 차단). `/ask/stream`=SSE(실단계 status→envelope 1회, res.on("close") 규격).
- 다이제스트: lifecycle이 자동 재생성(부재|n_docs 변화|--all), 기본 스코프 순회 ["shared","shared+admin"].

## 인증·역할 (mind)
- users.json `[{name, role admin|member, token_sha256, created_at, first_used_at(write-once), revoked_at?}]` — 평문 무저장. 부트스트랩 admin=env COSMOS_TOKEN.
- member 403: merge/discard/rollback/invite/slack-users/무브랜치·무owner 업로드. 열람·질의·본인 개인 공간은 허용.
- 초대: 슬랙 봇 DM(자기소멸 — 첫 인증 시 링크 삭제, 72h 만료), CLI `user add|list|revoke`, `invite <이름> <슬랙ID>`.

## 개인 지식 레포 커넥터 (M9.6 — 정본=각자의 GitHub 레포, 서버가 pull)
- 팀원 개인 지식의 정본은 **각자의 GitHub 레포**(권장: `ONOFFERDEV/knowledge-<이름>` private, 템플릿 `knowledge-template`에서 생성). PC측 스크립트·스케줄러 없음 — 레포에 .md를 쓰면 끝.
- mind `data/repos.json`: `[{owner, repo "owner/name", branch(기본 기본브랜치), token?, last_sha?, last_synced?}]`. token 없으면 env `GITHUB_KNOWLEDGE_TOKEN`(서버 공용 read 토큰) 폴백, 그것도 없으면 공개 레포만.
- 동기화: GitHub API `commits/{branch}` head sha 비교(무변경이면 skip) → `tarball` 다운로드 → gzip+tar를 **무의존 파서**로 풀어 `.md`만 추출 → core `/ingest {owner, docs}` (origin=`knowledge://<owner>/<경로>`, source_type=session). 파일 삭제 반영은 v1 미지원(교체는 origin replace로 반영).
- 주기: mind cron **1시간**(collect·lifecycle과 동일 메커니즘) + 웹 "지금 동기화".
- API(mind): `GET /my/repo`(본인 연결 상태) · `PUT /my/repo {repo, branch?, token?}`(본인 등록/변경 — owner는 identity로 강제) · `POST /my/repo/sync`(본인 즉시 동기화) · admin 전용 `GET /repos`(전체 목록·상태).
- 웹: 챗 바 [📝 내 지식 연결] = 레포 연결 패널(현재 상태·repo 입력·선택 토큰·지금 동기화).
- 주의: 관리자 PC의 파일 워처 동기화(파일경로 origin)와 같은 내용을 레포 커넥터로 이중 연결하면 origin이 달라 중복 문서가 된다 — 한 소스는 한 경로로만.

## 관계 그래프 (M10 v1 — 결정론 문서 링크 온톨로지)
- **원천은 저자가 쓴 명시적 관계뿐**(LLM 추출 없음 — 환각 0 설계): 본문 `[[이름]]`/`[[이름|표시]]`→`links`, frontmatter `up:`→`up`, `related:`→`related`.
- 저장: `doc_links(id, src_doc_id, rel_type, target_name 정규화, target_doc_id NULL허용)` — 무파괴 CREATE. 문서의 "이름"=origin 마지막 세그먼트 스템(.md 제거, 소문자 비교).
- **dangling은 1급 시민**(위키 철학): 대상 문서가 아직 없으면 target_doc_id=NULL로 저장, 그 이름의 문서가 나중에 ingest되면 **역해석 self-heal**. duplicate 재인제스트 시 관계 전체 재추출(멱등) — 일일 sync가 곧 백필.
- API(core): `GET /graph/docs/{doc_id}?owner_scope=` → {outbound, inbound}(각 항목=rel_type·target_name·해석된 문서 요약). `POST /graph/neighbors {doc_ids, owner_scope?, limit?}` → 1-hop 이웃 문서+첫 청크 스니펫. `GET /graph/links?owner_scope=` → 스코프 안에서 **양 끝이 모두 해석·노출 가능한** 링크 쌍 전량 {links:[{src_doc_id, dst_doc_id, rel_type}]}(dangling·브랜치 문서 제외 — 관계선 시각화용).
- **스코프 격리가 관계에도 적용**: 스코프 밖 개인 문서는 그래프 응답에서 항목째 제외(이름도 유출이다). dangling 이름은 코퍼스 밖이므로 노출 무해. /graph/links는 한쪽 끝이라도 스코프 밖이면 그 쌍 자체를 내지 않는다.
- 활용(mind fast): 검색 top-k 후 이웃 상위 N(기본 4)을 검색 결과 뒤에 합류(rerank 0점, source="graph") → LLM 인용 후보로 편입, trace.graph에 확장 기록. deep 적용·LLM 개념 관계 추출(concepts/relations 테이블)은 v2.
- 웹: 문서 패널에 "연결된 지식"(들어옴/나감, 코퍼스 내 링크는 점프, dangling은 이름만). **관계선 시각화**: /universe 페이로드에 `links`(mind가 core /graph/links를 합류, 미가용 시 빈 배열) — 3D 뷰가 문서 점 사이에 상시 은은한 선(가산 블렌딩)으로 그리고, 문서 선택 시 그 문서의 선만 밝게·나머지는 더 어둡게. 표시 옵션에서 켜고 끔(**기본 꺼짐** — 사용자 결정 2026-07-22, 켜면 localStorage 기억). 잠금 소등 클러스터에 걸친 선은 함께 회색.
- 게이트: ①추출(별칭·중복 dedup·자기링크 제외) ②dangling→역해석 왕복 ③무인증/타인 그래프에 개인 문서 0 ④fast에서 이웃 인용 합류 실측 ⑤전 회귀.

## 운영
- 운영 서버 compose 2서비스(온오퍼 배포분은 LAN 전용 바인딩): core(cosmos-data:/data/out, cosmos-models:/models) + mind(cosmos-mind-data:/data, cosmos-claude:/root/.claude, LLM=컨테이너 claude CLI).
- **이미지는 로컬 빌드 → `docker save | gzip | ssh docker load`** (서버 빌드는 -j32 하드행 금지). `up -d --no-build`. 배포 파이프의 exit는 PIPESTATUS로 확인.
- 마이그레이션 CLI: `cosmos-core migrate-owner --out <dir> [--source-type session] [--owner admin] [--dry-run]`, 스코프 부트스트랩: `bootstrap --owner <name>`(mind CLI `bootstrap --owner`는 LLM 라벨 포함, 슬러그 `p-<owner>-` 접두 유지).

---

## 포트
- cosmos-core: **8801** (mind는 8800 예약, M1)

## 디렉터리 레이아웃
```
D:\cosmos\
  core\                  Rust 크레이트 cosmos-core (lib + bin)
  mind\                  TS 오케스트레이션 (M1~)
  tools\                 Node 스크립트 (시드 수집·평가)
  contract\              이 문서 + openapi.yaml
  data\seed\             시드 코퍼스 (collect_seed.mjs 산출, git 제외)
  data\seed\manifest.json
  data\out\              색인 산출물 (git 제외)
    cosmos.sqlite3       정본 DB (벡터 BLOB 포함)
    tantivy\             BM25 역색인
  models\                fastembed 모델 캐시 (git 제외)
```

## 시드 매니페스트 형식 (`data/seed/manifest.json`)
```json
{
  "generated_at": "2026-07-13T00:00:00Z",
  "entries": [
    { "file": "wiki/foo-bar.md",
      "origin": "C:\\Users\\User\\.claude\\wiki\\foo-bar.md",
      "source_type": "session",
      "title": "foo-bar" }
  ]
}
```
- `file` = manifest.json 위치 기준 상대경로. `origin` = 원본 절대경로(답변 출처 표기에 사용).
- `source_type` ∈ `arxiv|rss|manual|session|repo|biz` (PLAN §4). 위키·메모리 = `session`.

## 검색 파이프라인 상수 (docseal 실증값 승계, core에서 `pub const`)
- `TOP_M_BM25 = 20`, `TOP_N_VEC = 20`, `RRF_POOL = 16`, `FINAL_TOP_K = 6`(기본 k), `RRF_K = 60`
- 임베딩 = BGE-M3 (1024d), 리랭커 = bge-reranker-v2-m3 (둘 다 fastembed/ONNX)
- 청킹: 목표 **1500바이트**, 오버랩 **200바이트**, 분할 선호 = 헤딩 > 빈 줄 > 문장 경계. 항상 UTF-8 문자 경계 정렬.

## 앵커 불변식 (게이트 대상)
- `char_start`/`char_end` = 문서 정규화 전문(全文)의 **UTF-8 바이트 오프셋, 문자 경계 정렬**
- 불변식: `text.len() == char_end - char_start` AND `doc_text[char_start..char_end] == text`
- 색인 stats에 `anchor_mismatches` 카운트 보고. **게이트 = 0.**

## SQLite DDL (M0)
```sql
CREATE TABLE docs(
  id TEXT PRIMARY KEY, source_type TEXT NOT NULL, origin TEXT NOT NULL UNIQUE,
  title TEXT, hash TEXT NOT NULL, n_chars INTEGER NOT NULL,
  ingested_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE chunks(
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id),
  seq INTEGER NOT NULL, text TEXT NOT NULL,
  char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
  section TEXT, cluster_ids TEXT NOT NULL DEFAULT '[]',
  embedding BLOB NOT NULL);
CREATE TABLE clusters(
  id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, description TEXT,
  status TEXT NOT NULL DEFAULT 'active', sensitivity TEXT,
  created_by TEXT, stats_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT);
CREATE TABLE concepts(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
  cluster_ids TEXT NOT NULL DEFAULT '[]', summary TEXT,
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]');
CREATE TABLE relations(
  id TEXT PRIMARY KEY, src_concept TEXT NOT NULL, dst_concept TEXT NOT NULL,
  rel_type TEXT NOT NULL, evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
  confidence REAL);
CREATE TABLE events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, inverse_json TEXT NOT NULL DEFAULT '{}');
```
- 임베딩 = f32 little-endian 1024개를 BLOB으로. 벡터 검색은 `VectorStore` 트레이트 뒤 브루트포스 코사인(M0), LanceDB는 M2.
- 재색인 규칙: 같은 `origin` + 같은 `hash` → duplicate 스킵. 같은 `origin` + 다른 `hash` → 구 doc+chunks 삭제 후 재삽입(교체), 저널에 `payload.replaced=true`.
- 저널: 모든 ingest는 `events`에 기록 (`kind=ingest`, `inverse_json={"delete_doc_id":...}`). M0은 append+조회만(롤백 실행은 M4).
- concepts/relations/clusters는 M0에서 테이블만 생성(빈 상태). `cluster_ids`는 `[]`.

## CLI (cosmos-core 바이너리)
```
cosmos-core index  --manifest <path> --out <dir> [--models <dir=D:\cosmos\models>]
cosmos-core search "<query>" --out <dir> [--k 6]          # JSON 출력
cosmos-core serve  --port 8801 --out <dir> [--models <dir>]
```
- `index`는 종료 시 stats JSON을 stdout에 출력: `{docs, chunks, anchor_mismatches, duplicates, replaced, secs}`

## M0 게이트 (검증=본체)
1. `cargo build --release` 에러 0
2. 시드 전량 색인: `anchor_mismatches == 0`
3. 평가셋 12문항 hit@6 ≥ **10/12** (hit = gold 파일이 top-6 results의 origin에 존재)
4. `/health` `/search` `/docs` `/journal` 실동작 (serve 모드)

---

# M1 확장 (2026-07-13)

## 클러스터 부트스트랩 (core, 결정론)
- 문서 벡터 = 소속 청크 임베딩의 **정규화 평균**. k-means(구면: 단위벡터 위 표준 k-means), **k ∈ [5..14] 실루엣 최고 선택**, seed 42, max_iter 50, n_init 4 — 같은 입력이면 같은 결과.
- 클러스터 centroid = 소속 문서 벡터의 정규화 평균 → `clusters.centroid BLOB` 컬럼에 f32 LE 저장 (**DDL additive 변경, M0 DB와 호환: `ALTER TABLE ... ADD COLUMN` 마이그레이션 허용**).
- 청크는 소속 문서의 클러스터를 상속 (`chunks.cluster_ids = [cluster_id]`).
- 초기 slug = `c01`..`c14` 자동, name/description = NULL → mind가 LLM 라벨링 후 PATCH.
- 저널: 클러스터당 `cluster_birth` 1건 + 배정 벌크 `assign` 1건(`{assignments: N}`) + PATCH마다 `cluster_rename`.
- 클러스터 존재 시 bootstrap은 409, `force=true`면 클러스터·배정 전체 삭제 후 재생성(저널 기록).

## 클러스터 스코프 검색 (core)
- `/search`의 `cluster_ids` = **합집합 스코프 필터**: 벡터 후보·BM25 후보 모두 해당 클러스터 소속 청크로 제한 후 RRF→리랭크(BM25는 후단 필터 허용, 필터 손실 보전 위해 BM25 원후보 TOP_M을 40으로 확장해 필터).

## 라우팅 (`/route`=core 점수, 결정=mind)
- core: 전 active 클러스터에 대해 `centroid_sim`(질문 임베딩 코사인) + `bm25_hits`(전역 BM25 상위 20 중 소속 청크 수) 반환.
- mind 결정 디폴트: `score = centroid_sim + 0.02·min(bm25_hits,10)`, 내림차순 상위 **K=3** consulted, 나머지 skipped. 단 `score < 0.6·top_score`면 K 내라도 skipped. trace의 why에 수치 명시(예: "score 0.81 (rank 1)" / "0.22 < 0.6·top").

## mind (TS, 포트 8800) — M1 범위
- 스택: Node 22 + TypeScript(strict), **런타임 의존성 0**(node:http·child_process·global fetch), 빌드=tsc→dist. 이유: 공급망 최소·[[pnpm-undeclared-dep-stale-artifacts-clean-checkout]] 류 지뢰 회피.
- LLM 백엔드 = `LlmClient` 추상화 2종: **`claude-cli`(기본)** — `claude` exe 직접 spawn, `-p --model sonnet --output-format text`, 프롬프트는 stdin(전달 후 stdin close로 EOF), `.cmd` 아닌 exe, `--bare` 금지, shell:false·args 배열(인용 지뢰 회피) / **`api`** — `ANTHROPIC_API_KEY` 존재 시 messages API 직호출(모델 claude-sonnet-5). 선택: env `COSMOS_LLM`(기본 claude-cli).
- 구조화 출력: 프롬프트에 JSON 형태·필드명·리터럴 예시를 직접 박고(제약 디코딩 없음) 파싱 실패 시 1회 재시도.
- CLI: `bootstrap`(core bootstrap→클러스터별 샘플로 LLM 라벨링→PATCH), `ask "질문"`, `serve --port 8800`.
- `/ask` 응답 봉투(정본, PLAN §5.3 구체화):
```json
{ "answer": "전체 답변 텍스트([n] 인용 포함)",
  "sentences": [{"text":"...", "cites":[1,2]}],
  "sources": [{"n":1, "origin":"C:\\...\\foo.md", "title":"...", "chunk_id":"...", "char_start":0, "char_end":1457}],
  "trace": [{"cluster":"llm-pipeline", "action":"consulted", "why":"score 0.81 (rank 1)"},
             {"cluster":"game-server", "action":"skipped", "why":"score 0.22 < 0.6·top"}],
  "insufficient": false, "mode": "fast",
  "cost": {"llm_calls":1, "secs":8.2, "model":"sonnet"} }
```
- **안티환각 규약**: 답변은 제공 청크 근거만 사용하도록 프롬프트 고정, `insufficient` 판단은 ①LLM 자가판단 ②cites 없는 문장만 존재 ③검색 최고 rerank_score < 0.0(단락, LLM 무호출) 셋 중 하나라도 참이면 true → answer 대신 차단 메시지. 모든 문장은 cites 필수(없으면 "미인용" 표시).
- 질의 로그: mind가 `data/queries.jsonl`에 append(질문·mode·trace·cost·ts). core Query 테이블은 M2.

## M1 게이트 (검증=본체)
1. bootstrap: 클러스터 5~14개, 전 129문서 배정, 실루엣 보고, 저널에 cluster_birth+assign+rename 기록, LLM 라벨(한국어 name/description) 부여.
2. eval_ask 긍정 10문항: `insufficient=false` AND gold 파일이 인용 sources에 포함 ≥ **8/10**.
3. 부정 3문항(코퍼스 밖): `insufficient=true` **3/3**.
4. 전 응답 trace에 consulted≥1 + skipped≥1(why 수치 포함).
5. 각 레인 테스트 실행 증거 필수(cargo test / node --test + tsc, 실제 출력 인용) — [[subagent-selfverify-build-green-not-test-green]].

---

# M2 확장 (2026-07-13) — 유입 3경로 + 승인 게이트

## 승인 게이트 (사용자 확정 요구: "수집하고 나서 승인이 있어야 진행")
- **source_type별 정책(설정형, 기본값)**: `arxiv`·`rss` = **승인 필수**(pending 큐 경유, 승인 전 절대 미색인) / `manual` = 즉시 색인(사용자 직접 행위=암묵 승인) / `session`(메모리·위키 워처) = 자동(이미 사용자 검수된 정본의 파생 색인).
- **inbox 저장소(mind 관할, 파일 기반)**: `data/inbox/pending/{id}.json` → approve 시 core /ingest 성공 후 `approved/`로 이동, reject 시 `rejected/`로 이동. id = sha256(origin) hex 앞 12자. 이동 파일에 `decided_at`, `decision` 필드 추가.
- 후보 파일 스키마: `{id, source_type, origin(url), title, summary(초록·발췌 500자), score, matched(매칭 키워드 배열), fetched_at, text(색인용 전문), status:"pending"}`
- CLI(mind): `collect` / `inbox`(대기 목록 표) / `approve <id...>|--all` / `reject <id...>` · HTTP(mind): `GET /inbox`, `POST /inbox/{id}/approve`, `POST /inbox/{id}/reject`(향후 UI용).

## 수집기 (LLM 무사용 — 수집·선별 전 과정 결정론, 판단은 사람)
- **arXiv**: `http://export.arxiv.org/api/query`, 카테고리 설정형(기본 cs.CL, cs.AI, cs.LG, cs.RO, physics.space-ph), submittedDate desc max 50/카테고리, 커서 `data/collect.state.json`(마지막 수집 id/시각)으로 재수집 방지. 텍스트 = 제목+저자+초록(전문 PDF 비목표). Atom XML 최소 파싱(정규식 허용).
- **프로파일 점수**: 설정의 가중 키워드 매칭(제목 2×, 초록 1×, 대소문자 무시). 상위 `MAX_PENDING_PER_RUN=20`건만 pending 진입, 탈락은 콘솔 로그만.
- **RSS/Atom**: 설정 `feeds[]`, item/entry 최소 파싱, description HTML 태그 제거. 실패 피드는 경고 후 스킵(수집 전체를 죽이지 않음). 기본 활성 피드는 **실존 검증된 것만**(불확실하면 arXiv만 기본, 예시는 disabled로 동봉).
- 설정 파일: `D:\cosmos\cosmos.config.json` — `{collect:{arxiv:{categories,max_per_category}, rss:{feeds:[{url,enabled}]}, profile:{keywords:[{term,weight}]}, max_pending_per_run}, watcher:{dirs:[...], interval_secs:60}, policy:{arxiv:"approval", rss:"approval", manual:"direct", session:"auto"}}` — 기본 profile 키워드는 Cosmos 도메인(llm/agent/robotics/space + rust/cloudflare/figma 등 회사 기술) 시드.

## 워처 (session 경로)
- **폴링 스캐너**(fs.watch 미사용 — Windows 신뢰성): 기본 60s 간격(설정형), 대상 = 메모리·위키 디렉터리(설정형, 기본 `C:\Users\User\.claude\projects\D--\memory`·`C:\Users\User\.claude\wiki`, MEMORY.md·dashboard.md·index/log.md·_templates 제외 규칙은 M0 수집기와 동일).
- 방식: 전 파일 core /ingest 벌크 → **core가 origin+hash 멱등 처리**(불변=duplicate 스킵, 변경=교체) → 워처는 상태 무보관. `scan` 단발 CLI + mind serve 내 타이머 둘 다.

## core ingest-시 클러스터 배정 (M2 신규)
- active 클러스터 존재 시: 신규/교체 문서의 문서벡터(청크 임베딩 정규화 평균) ↔ centroid 코사인 → **argmax 클러스터 배정**(전 청크 cluster_ids 상속), `fit`(cos값)을 docs.meta_json에 기록, `fit < FIT_THRESHOLD(0.5)`면 meta_json.low_fit=true(M4 misfit·탄생 대비). 문서당 저널 `assign` 1건.
- **duplicate 판정(origin+hash)은 임베딩 이전 수행**(비용 지뢰 방지) — 미준수 시 결함.
- `IngestResponse.ingested[]`에 `cluster_slug`(nullable)·`fit`(nullable) additive 추가.

## M2 게이트 (검증=본체)
1. collect 실행 → pending ≥1 생성 **그 시점 core docs 수 불변**(승인 전 미색인 증명) + 질의에도 미등장.
2. approve 1건 → 색인+자동 클러스터 배정(fit 기록·저널 assign)+fast ask에서 해당 문서 인용 등장(종단).
3. reject 1건 → rejected/ 이동·미색인.
4. 워처: 임시 디렉터리로 신규→색인 / 수정→교체 / 불변→duplicate 실증 + **실제 메모리·위키 1회 스캔 = 전량 duplicate(기존 129 무손상)**.
5. manual: 로컬 md 1건 + URL 1건 즉시 색인.
6. 전 레인 테스트 실행 증거([[subagent-selfverify-build-green-not-test-green]]).

---

# M3 확장 (2026-07-13) — deep 협의 모드

## 파이프라인 (mind, core 변경 없음 — 기존 /route·클러스터 스코프 /search 재사용)
```
질문 → [플래너 Opus 1콜] → 협의 계획
     → [클러스터 에이전트 Sonnet, 병렬 1콜씩] → 증거 브리프 K개
     → (모순 감지 시) [반박 라운드 최대 1회] → 브리프 수정
     → [종합 Opus 1콜] → 최종 답변+주장별 출처+궤적
```
- **모델 라우팅**: 플래너·종합=opus, 클러스터 에이전트=sonnet. `LlmClient`를 콜별 model 파라미터(`"sonnet"|"opus"`)를 받도록 확장 — claude-cli는 `--model <alias>`, api 백엔드는 sonnet→`claude-sonnet-5`, opus→`claude-opus-4-8`.
- **에이전트는 도구 루프 없음(v1)**: mind가 해당 클러스터 스코프로 core /search(k=8)를 실행해 청크를 프롬프트에 동봉 → 에이전트는 단일 콜로 브리프 생성. 비용 상한 보장.
- **직렬화**: deep 실행은 프로세스 전역 동시 1건(뮤텍스). fast는 영향 없음.
- 예산 상한: 참여 클러스터 K ≤ 4(플래너가 그 이상 제안해도 mind가 점수순 상위 4로 컷, 컷된 것은 skipped에 "예산 컷" 이유).

## 플래너 계약 (입력: 질문 + 클러스터 카탈로그(slug/name/desc/n_docs) + /route 점수)
출력 JSON:
```json
{ "subquestions": [{"cluster_slug":"...", "question":"클러스터 맞춤 하위 질문"}],
  "skipped": [{"cluster_slug":"...", "why":"플래너 판단 이유"}],
  "strategy": "1문장" }
```
- 클러스터당 하위 질문 1개(동일 질문 재사용 가능). subquestions에 없는 active 클러스터는 전부 skipped에 이유와 함께 존재해야 함(누락 금지 — trace 완전성).

## 클러스터 에이전트 브리프 계약
입력: 하위 질문 + 번호 청크 [1..n](자기 클러스터 스코프) / 출력 JSON:
```json
{ "claims": [{"text":"근거 있는 주장 1문장", "cites":[1,2], "confidence":0.9}],
  "gaps": ["이 클러스터에 없는 정보"],
  "notes": "선택" }
```
- cites 없는 claim 금지(파싱 후 mind가 드랍). 근거 없으면 claims=[] + gaps 기술.

## 모순 검사·반박 라운드 (최대 1회)
- 종합 1차 콜(Opus)이 브리프 전체를 받고 `{"contradictions":[{"a_cluster":"...","a_claim":"...","b_cluster":"...","b_claim":"...","issue":"..."}], ...}`를 함께 출력.
- contradictions 비어있으면 그대로 최종화. 있으면 관련 에이전트에게 상대 주장을 제시해 1회 재브리프 → 종합 2차 콜이 최종. 2차에서도 남은 모순은 답변에 "상충 근거" 문단으로 명시(숨기지 않음).

## deep 봉투 (fast 봉투 확장, additive)
- `mode:"deep"`, trace의 consulted 항목에 `{subquestion, claims}` 추가, skipped why는 플래너 이유(또는 예산 컷). `cost.llm_calls`=플래너+에이전트+반박+종합 합계, `cost.stages`=단계별 secs.
- sources는 전 클러스터 브리프의 인용 청크를 전역 재번호. 문장→cites 매핑은 fast와 동일 규약.
- insufficient: 전 브리프 claims 합계 0 → LLM 종합 생략하고 차단. 이하 fast 3중 가드 철학 동일.

## 트리거
- HTTP: POST /ask `{question, mode:"deep"}` · CLI: `ask "질문" --deep`.

## M3 게이트 (검증=본체, A/B)
- 교차 클러스터 질문 5개: 같은 질문을 fast와 deep으로 실행.
  1. deep이 **서로 다른 클러스터 ≥2의 출처**를 인용 ≥4/5.
  2. deep이 fast가 못 찾은 출처 문서 ≥1 회수 ≥3/5.
  3. trace 완전성 5/5: 전 active 클러스터가 consulted(하위질문 포함) 또는 skipped(이유)로 존재.
- 부정 1문항(코퍼스 밖): deep도 insufficient 차단.
- 지연·콜 수 기록(게이트 아님, 참고).
- 전 레인 테스트 실행 증거 의무.

## LLM 타임아웃 규격 (M3 게이트 1차 실측 후 개정, 2026-07-13)
- 근거: claude CLI 헤드리스는 고정 오버헤드+생성으로 Sonnet 30~123s 실측, Opus는 120s 상한 초과로 deep 플래너가 전량 중단됨.
- **LlmClient 타임아웃 = 모델별 기본**: sonnet **360s**(3차 실측 개정 — deep 병렬 에이전트가 레이트리밋 공유 풀에서 180s 초과), opus **420s**. env `COSMOS_LLM_TIMEOUT_SONNET_MS`/`COSMOS_LLM_TIMEOUT_OPUS_MS` 오버라이드.
- **deep 에이전트 동시성 = 2**(3차 실측 개정): 클러스터 에이전트 병렬 실행을 동시 2개로 제한(단순 풀) — 공유 레이트리밋 계정에서 3~4개 동시 CLI spawn이 개별 호출을 극단적으로 지연시킴.
- **클라이언트 헤더 타임아웃 함정(3차 실측)**: Node fetch(undici)는 자체 headersTimeout 기본 300s — 서버 requestTimeout=0이어도 5분 초과 응답은 클라이언트가 절단("fetch failed"). **장시간 /ask 호출부(평가 하네스 등)는 fetch 금지, node:http 직접 사용**(자체 타임아웃 명시, deep 1200s/fast 300s).
- mind serve는 deep 단계 전이(플래너 시작/완료, 에이전트 N 병렬 시작/완료, 반박, 종합)를 타임스탬프와 함께 콘솔에 로그(진단성).
- **평가 하네스 fetch 타임아웃**: fast **300s**, deep **900s**(AbortController). 타임아웃 발생 시 report에 어느 쪽 타임아웃인지 명시.

## 서버 소켓·진단 규격 (M3 게이트 2차 실측 후 개정, 2026-07-13)
- 근거: Node http 서버 기본 `requestTimeout`(300s)이 5분 초과 deep 응답의 소켓을 강제 절단(클라이언트에 "fetch failed") — qd02/qd04 실측.
- **mind http 서버**: `server.requestTimeout = 0`(비활성) 설정. keepAliveTimeout/headersTimeout은 기본 유지.
- **진단 의무**: mind가 /ask 처리 중 예외를 500으로 변환할 때 **콘솔에도 console.error로 스택+단계 컨텍스트 기록**(삼키기 금지). 평가 하네스는 비-2xx 응답의 **본문을 report error 문자열에 포함**.
- **문서→클러스터 매핑(판정용)**: core GET /docs가 `cluster_slug`(nullable)·`fit`(nullable)을 노출(openapi 갱신됨, 청크 cluster_ids 기준) — eval_deep의 검색 근사 매핑 폐기하고 /docs 직독으로 교체.

## M2 백로그 처리 (tools 레인)
- eval_m2 게이트2 측정 채널 수정: CLI stdout JSON 파싱 가정 폐기 → **approved/{id}.json의 cluster_slug·fit 존재 + core /docs origin 실재 + docs 증가**로 판정(2026-07-13 수동 검증과 동일 증거 채널). judge 테스트 갱신 포함.

---

# M4 확장 (2026-07-13) — 클러스터 생명주기 + 3D 우주 뷰

## core 생명주기 연산 (전부 결정론, LLM 무관)
- **misfit**: `fit < FIT_THRESHOLD(0.5)` 문서. `GET /misfits` → `[{doc_id,origin,title,fit,cluster_slug}]`.
- **`GET /lifecycle/proposals`** (쿼리 파람: birth_min=12, birth_cohesion=0.55, merge_sim=0.85 — 기본값): 
  - births: misfit 문서벡터 상호 코사인 그리디 그룹핑 → 크기≥birth_min AND 평균 내부 코사인≥birth_cohesion 그룹만 `{doc_ids[], cohesion, sample_titles[≤5]}`.
  - merges: active 클러스터쌍 centroid 코사인≥merge_sim → `{a_id,b_id,a_slug,b_slug,centroid_sim}` (참고: 단일 배정 체제라 교차소속 신호는 미사용).
- **`POST /clusters/birth`** `{doc_ids[], slug, name?, description?}`: 새 클러스터 생성(centroid=문서벡터 정규화 평균), 해당 문서 전 청크 재배정, docs.meta_json fit 재계산. 저널 `cluster_birth`, **inverse_json = {doc_id별 이전 cluster_ids·이전 meta_json, 신규 cluster_id}** (완전 원복 가능해야 함).
- **`POST /clusters/merge`** `{src_id, dst_id}`: src 문서·청크를 dst로 재배정, dst centroid 재계산, src.status='merged'+merged_into 기록. 저널 `cluster_merge`, **inverse_json = {src 클러스터 행 스냅샷, 이동 문서·청크 배정 스냅샷, dst 구 centroid}**.
- **`POST /rollback`** `{seq}`: 해당 이벤트의 inverse 적용. v1 지원 kind = `cluster_birth`·`cluster_merge`·`cluster_rename`. 롤백 자체도 저널 기록(kind=`rollback`, payload={target_seq}). 이미 롤백된 이벤트·미지원 kind는 409/에러.
- Tantivy/벡터 색인은 클러스터 무관(배정은 SQLite만)이므로 재색인 불요 — 배정 테이블만 원자적으로.

## mind 생명주기 데몬
- CLI `lifecycle run [--dry-run]` / `lifecycle status`. (상시 스케줄은 M5 cron에서.)
- run: core proposals 조회 → **birth**: 후보마다 sample_titles로 LLM 명명(slug/name/desc, bootstrap.ts 라벨링 재사용) → POST birth. → **merge**: `data/lifecycle.state.json`에 관측 기록, **2회 연속 run에서 같은 쌍 관측 시에만** POST merge(히스테리시스). 결과 표 출력.
- 정책 임계값은 cosmos.config.json `lifecycle` 절(기본값=위 파람)로.
- **merge_sim 캘리브레이션(M4 게이트 실측, 2026-07-14)**: BGE-M3 centroid는 동일 도메인 클러스터끼리 0.86~0.93이 일상 — 0.85는 과민(실 클러스터 6쌍이 후보로 떠 히스테리시스 2회 후 전부 병합될 뻔). **운영 기본 = 0.95**. 진짜 중복(재부트스트랩 잔재 등)만 잡는 값.

## `GET /universe` (mind — 3D 뷰 데이터, 결정론)
```json
{ "generated_at": "...",
  "clusters": [{"id","slug","name","description","status","n_docs","n_chunks","pos":[x,y,z],"radius":r}],
  "docs":     [{"doc_id","title","origin","source_type","cluster_slug","fit","pos":[x,y,z]}],
  "edges":    [{"a":"slugA","b":"slugB","weight":0.42}],
  "recent_queries": [{"ts","question","mode","consulted":["slug"],"skipped":["slug"]}] }
```
- 클러스터 pos = centroid 코사인 거리 행렬의 **고전 MDS 3D**(클러스터 수 k≤20이라 경량), 좌표 스케일 [-100,100], **결정론**(동일 입력→동일 좌표, Math.random 금지). centroid는 core `GET /clusters/centroids`(신규, `[{id, centroid: base64 f32le}]`)에서.
- radius ∝ sqrt(n_chunks) (최소 6, 최대 40). doc pos = 소속 클러스터 pos + hash(doc_id) 기반 결정론 방향 × 거리 `(1-fit)·radius·0.9` (fit null→0.55 가정).
- edges: centroid 코사인 ≥ 0.3 쌍만. recent_queries = data/queries.jsonl 마지막 20건 요약.

## 3D 웹 뷰 (mind/web/ — 순수 정적 프론트, mind/src 무접촉)
- mind server가 `GET /` → `web/index.html`, `/web/*` 정적 서빙(Content-Type 정확히). **외부 요청 0**(CDN·폰트 금지, [[csp-silently-blocks-google-fonts-import]]) — three.js는 `web/vendor/three.module.min.js`로 벤더링.
- 씬: 다크 우주 테마. 클러스터=발광 성운 구체(radius 반영, 라벨 항상 가독), 문서=클러스터 주위 파티클(source_type별 색: session/arxiv/rss/manual 구분, fit 낮을수록 바깥), edges=희미한 곡선. OrbitControls(벤더링). 호버/클릭 → 우측 정보 패널(클러스터: 이름·설명·문서 수·대표 문서 / 문서: 제목·origin·fit).
- **질문 박스**(fast/deep 토글): POST /ask → 응답 trace로 **궤적 애니메이션**(consulted 클러스터를 순서대로 광선/펄스 통과, skipped는 일시 감광) → 답변+출처 패널(문장별 [n], 출처 클릭 시 해당 문서 파티클 하이라이트). deep 소요(수 분) 동안 진행 인디케이터.
- 한국어 UI. 데스크톱 우선(모바일 비목표).

## M4 게이트 (검증=본체, 파괴 연산은 실DB 사본에서)
1. 탄생 종단(사본): 이질 코퍼스 12건 ingest→misfit 적재→proposals 후보→lifecycle run→LLM 명명 클러스터 탄생·재배정·저널 inverse 완비.
2. **birth 롤백 왕복 무손실**: 롤백 후 문서 배정·meta_json·클러스터 목록이 탄생 전과 완전 일치(스냅샷 diff 0).
3. **merge→롤백 왕복 무손실**: 병합 실행 후 롤백 → src 클러스터 행·배정 원상복구(diff 0).
4. /universe: 수치 정합(실 클러스터·문서 수 일치), 결정론(2회 호출 좌표 동일), edges 대칭·중복 없음.
5. 3D 뷰: 헤드리스 스크린샷 렌더 확인(빈 캔버스 아님, [[headless-edge-min-window-width-artifact]] 주의) + 본체 육안 + **사용자 데모**(질문 궤적 애니메이션은 사용자 검토 몫).
6. 전 레인 테스트 실행 증거.

---

# M5 확장 (2026-07-14) — Rocky 팀 배포 + 토큰 인증 + MCP + cron

## 결정(사용자 2026-07-14): Rocky LLM 백엔드 = **컨테이너 claude CLI**(Max OAuth 공유, 추가 과금 없음)

## 컨테이너 구성 (deploy/ 디렉터리, docker compose 2서비스)
- **core**: 베이스 `rust:1-trixie`(glibc 2.38+ 필수 — [[ort-onnxruntime-glibc-238-docker-base]]), 멀티스테이지(release 빌드→slim 런타임). 볼륨: `cosmos-data:/data/out`, `cosmos-models:/models`(fastembed 첫 실행 다운로드 허용). **포트 비공개**(compose 내부망 전용, mind만 접근).
- **mind**: 베이스 `node:22-slim` + **claude CLI 설치**(`npm i -g @anthropic-ai/claude-code`). 볼륨: `cosmos-claude:/root/.claude`(OAuth 자격증명 영속 — 컨테이너 안에서 1회 `claude /login`, headless URL 방식). env: `COSMOS_LLM=claude-cli`, `COSMOS_CORE_URL=http://core:8801`, `COSMOS_TOKEN`. 포트 **8800만 LAN 노출**. web/ 정적 포함.
- core-client의 core 주소는 env `COSMOS_CORE_URL`(기본 http://127.0.0.1:8801) — 하드코딩 제거.
- 배포 타깃: 사내 서버(ssh 키, docker compose 검증됨 — video-automation 8320/8321과 포트 무충돌). 데이터 이관 = data/out(sqlite+tantivy)을 볼륨에 rsync(재임베딩 회피).

## 토큰 인증 (mind, env COSMOS_TOKEN 설정 시 활성)
- **보호**: POST /ask, /inbox/*, /ingest(신설 프록시), lifecycle 관련 — `Authorization: Bearer <token>` 불일치 시 401 JSON(한국어).
- **공개(LAN)**: GET /·/web/*(정적), /health, /universe (읽기 전용 뷰).
- 웹 UI: 401 수신 시 토큰 입력 프롬프트→localStorage 저장→헤더 자동 첨부.

## 원격 유입 (Rocky는 Windows 경로를 못 본다)
- mind에 **POST /ingest 프록시**(토큰 보호) 신설 → core /ingest 전달.
- mind에 **POST /search 프록시**(공개, 읽기 전용) 신설 → core /search {query,k?} 그대로 전달·응답 그대로(MCP cosmos_search 소비처, 2026-07-14 MCP 레인 발견으로 추가).
- 로컬 PC의 `mind scan`이 env `COSMOS_MIND_URL`+`COSMOS_TOKEN` 설정 시 로컬 core 대신 원격 mind 프록시로 전송 — 위키·메모리 동기화는 로컬 PC에서 실행(수동 또는 로컬 스케줄).
- Rocky mind의 자체 파일 워처는 컨테이너에선 비활성(watcher.dirs 부재 시 자동 스킵+로그 1줄).

## cron (mind serve 내 타이머, config 신설 `cron` 절)
- `collect.interval_hours`(기본 24, 0=off) → 주기 collect(pending 승인 대기라 자율 위험 0).
- `lifecycle.interval_hours`(기본 24, 0=off) → 주기 lifecycle run(병합은 기존 2회 히스테리시스가 방어).
- 기동 시각은 정각 회피(기동 시점 기준 상대 타이머면 충분). 실행 결과는 콘솔 로그+data/cron.log(1줄/회).

## MCP 정식화 (신규 패키지 `mcp/` — 이 패키지만 npm 의존성 허용: @modelcontextprotocol/sdk)
- stdio MCP 서버 `cosmos-mcp`: env `COSMOS_MIND_URL`(기본 http://localhost:8800)+`COSMOS_TOKEN`으로 mind HTTP 호출.
- tools: `cosmos_ask{question, mode?}`(봉투 요약: 답변+출처+궤적), `cosmos_search{query,k?}`, `cosmos_ingest{url_or_text,title?}`, `cosmos_inbox_list{}`, `cosmos_inbox_approve{ids[]}`, `cosmos_inbox_reject{ids[]}`, `cosmos_status{}`(health+클러스터).
- 등록 스니펫(.mcp.json)과 사용법을 mcp/README.md에.
- deep은 수 분 소요 — tool 설명에 명시, 타임아웃 여유(1200s).

## M5 게이트 (검증=본체, 실 Rocky)
1. compose up: core+mind 기동, 데이터 이관 후 /health docs 수 = 로컬과 일치.
2. PC 브라우저에서 http://localhost:8800 — 3D 뷰 로드+fast ask 종단(컨테이너 claude CLI 실동작).
3. 토큰: 무토큰 /ask 401, 유토큰 200.
4. **동시 사용자**: fast ask 2건 병렬 → 둘 다 정상 봉투(멀티유저 게이트).
5. MCP: PC의 클로드 세션에서 cosmos_ask → 인용 답변 수신(타 세션 게이트).
6. cron: 짧은 간격 오버라이드로 collect·lifecycle 타이머 발화 실증(로그 증거).
7. 원격 scan: PC에서 COSMOS_MIND_URL로 scan → Rocky 우주에 반영.

---

# M6 확장 (2026-07-14) — Knowledge Hub 완전 편입

## 결정(사용자): 프로젝트 정본 문서 + 대시보드·인덱스류 편입, RESULTS 로그 제외, PC→Rocky 동기화=윈도우 스케줄러 일 1회

## 스캔 소스 확장 (mind watcher — 실행 주체는 PC의 scan, Rocky는 수신만이라 재배포 불요)
- config 신설 `sources` 절(기존 watcher.dirs는 하위호환 유지):
```json
"sources": [
  {"path": "C:\\Users\\User\\.claude\\projects\\D--\\memory", "source_type": "session", "include_meta": true},
  {"path": "C:\\Users\\User\\.claude\\wiki", "source_type": "session", "include_meta": true},
  {"path": "D:\\cosmos", "source_type": "repo", "docs_only": true},
  {"path": "D:\\docseal", "source_type": "repo", "docs_only": true}, ...
]
```
- `include_meta: true` = 기존 제외 규칙 중 **dashboard.md·MEMORY.md·index.md·log.md 를 포함으로 전환**(_templates/ 는 계속 제외).
- `docs_only: true` = 프로젝트 레포 모드: **PLAN*.md, DESIGN*.md, README.md(루트만), docs/**/*.md, design/**/*.md, contract/**/*.md** 만 수집. **전역 제외**: RESULTS.md(전 위치), node_modules/, target/, dist/, .git/, .omc/, data/, models/, vendor/.
- source_type=repo 정책: config policy에 `"repo":"auto"` 추가(자사 정본 문서 — 승인 불요, 세션과 동급).
- origin=절대경로(기존 규약), 재스캔 멱등(origin+hash)이 갱신 처리.

## PC 동기화 자동화
- `tools/sync-hub.ps1`: COSMOS_MIND_URL=http://localhost:8800, 토큰=data/cosmos_token.txt 읽기 → `node mind/dist/cli.js scan` → 결과 1줄을 data/sync-hub.log append(날짜 포함, 최근 200줄 유지). 서버 미응답 시 조용히 종료(exit 0, 로그만).
- 윈도우 작업 스케줄러 등록(관리자=본체 실행): 일 1회 09:23, 놓친 스케줄은 다음 로그온 시 실행(StartWhenAvailable).

## M6 게이트 (검증=본체)
1. scan이 프로젝트 정본 문서·대시보드류를 실제 수집(신규 N>0 보고, RESULTS.md 0건 검증).
2. Rocky ask: "docseal의 설계 핵심이 뭐야?" 류 질문이 **PLAN/설계 문서를 인용**해 답변.
3. 대시보드 질문("요즘 프로젝트들 현황 요약")이 dashboard.md 인용.
4. 스케줄러 태스크 등록 확인 + 수동 1회 발화(schtasks /run)로 종단 동작.
5. 테스트 실행 증거.

# M7 확장 (2026-07-14) — 전역(열거형) 질문: 레지스트리 + 인텐트 게이트 + 클러스터 다이제스트

## 결정(사용자): "전체 현황"류 열거형 질문 대응, 범위=다이제스트까지 전부
- 진단: top-k 유사도 검색은 완전성을 보장 못함. 인덱스 문서(MEMORY.md)는 임베딩이 흐려져 오히려 순위 하락(M6 실측: 전체 현황 질문에 30개 중 3개만 답변, MEMORY.md rank-4 skip). deep도 에이전트 내부 k=8 절단으로 미해결.
- 원칙: **완전성이 필요한 답은 완전성을 보장하는 구조(레지스트리/다이제스트 전수)에서 나와야 한다** — 유사도 검색은 보조.

## core: 엔티티 레지스트리 (파생 데이터 — 저널 무기록, 재스캔으로 재구축 가능)
- DDL: `CREATE TABLE IF NOT EXISTS entities (doc_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT, status TEXT, phase TEXT, next_action TEXT, blocked_on TEXT, updated TEXT)` (doc_id → docs FK 의미, 문서 삭제/교체 시 함께 정리).
- ingest 시 문서 텍스트 선두 `---` YAML frontmatter 파싱(serde_yaml 허용, BOM 허용): `name`(없으면 `title`, 없으면 skip), `description`, `metadata.type`→kind(없으면 최상위 `category`, 없으면 "unknown"), `metadata.project_status`→status, `metadata.phase`→phase, `metadata.next`→next_action, `metadata.blocked_on`→blocked_on, `metadata.updated`(없으면 최상위 `updated`)→updated. frontmatter 없거나 파싱 실패 → entity 없이 정상 진행(무크래시).
- **duplicate(동일 origin+hash) 경로에서도 entity upsert 수행** — 임베딩 없이 싼 연산, 일일 재스캔이 기존 문서의 entity를 자가 치유(backfill 명령 불요).
- `GET /entities?kind=project` — kind 생략 시 전체. 응답=Entity 배열(openapi 정본).

## core: 클러스터 다이제스트 저장 (파생 데이터 — 저널 무기록)
- DDL: `CREATE TABLE IF NOT EXISTS cluster_digests (cluster_id TEXT PRIMARY KEY, text TEXT NOT NULL, model TEXT, updated_at TEXT NOT NULL)`.
- `PUT /clusters/{cluster_id}/digest` body `{text, model}` (mind가 생성해 기록, 404=없는 클러스터), `GET /clusters/digests` = **active 클러스터만** 조인해 전체 반환(merged/롤백 잔재 다이제스트 자연 차폐).

## mind: 인텐트 게이트 (결정론, LLM 무사용 — intent.ts)
- `classifyIntent(q) → "global" | "point"`: 한국어/영어 열거 신호 패턴(전체·전부·모든·모두·목록·나열·한눈에·현황+요약류·"뭐가 있"·"어떤 것들"·프로젝트들·list all·overview·roster 등) 매치 시 global, 그 외 point. 유닛테스트로 고정.
- `/ask` 요청에 `mode: "auto"|"point"|"global"` 신설(기본 auto=게이트 판정, 명시 시 강제). 응답 봉투에 `mode` 필드 추가(실행된 모드).

## mind: global 파이프라인 (fast급 1 LLM 콜)
- 수집(전부 결정론): ①`GET /entities`(전체, kind별 그룹) ②`GET /clusters/digests`(전수 — 클러스터 수 ≤14라 검색 불요) ③일반 하이브리드 /search k=6(문구 특이성 보강용 병합).
- 종합(Sonnet 1콜): 완전성 우선 지시 — 질문이 특정 kind(예: 프로젝트)면 **레지스트리의 해당 kind 전 행을 다룰 것**(상태·영역별 그룹핑 허용), 레지스트리에 없는 엔티티 언급 금지. 봉투는 fast와 동일하게 sentences+cites 결정적 조립.
- 출처: entity 인용=해당 doc origin. 다이제스트 인용=합성 origin **`digest://<cluster_slug>`** 허용(웹/MCP는 "클러스터 다이제스트: <name>"으로 표시). trace=전 클러스터 `consulted`, why="global digest".

## mind: 다이제스트 생성 (digest.ts + lifecycle 연동)
- 입력: 클러스터 slug/name/desc + 멤버 문서 목록(제목+origin, **전문 미포함**) + n_docs/n_chunks. 출력: 한국어 300~600자 — 주제 요약, 대표 문서(제목), 최근 갱신점. 모델=sonnet.
- 재생성 시점: bootstrap 직후 / birth·merge·rollback 후 / lifecycle cron 실행 시 n_docs 변화 또는 다이제스트 부재 클러스터만. CLI `node dist/cli.js digest [--all]`(--all=강제 전체).

## M7 게이트 (검증=본체)
1. 유닛: 인텐트 분류 글로벌 10문구+포인트 10문구 무오탐 / frontmatter 파서 4형(메모리형·위키형·frontmatter 없음·깨진 YAML→skip 무크래시) / duplicate 경로 entity upsert.
2. 레지스트리 완전성: `/entities?kind=project` 건수 = memory 폴더 project 파일 수와 일치(결정론 층 100%).
3. E2E(Rocky): "온오퍼 프로젝트 전체 현황 정리해줘" → mode=global, 답변에 레지스트리 프로젝트 이름 ≥90% 포함(스크립트 대조), 레지스트리 밖 환각 프로젝트 0.
4. 다이제스트: 전 클러스터 생성, 각각 실제 멤버 문서 제목 ≥3 언급(샘플 검증), birth/merge 후 재생성(사본 DB에서).
5. 회귀: point 질문("docseal 설계 핵심") 기존 경로·인용 유지, 기존 테스트 전량 green.
6. 배포: core·mind 이미지 로컬 재빌드→save/load(M5 절차), Rocky에서 E2E 재확인.

# M7.5 확장 (2026-07-15) — 웹 챗 UI + 진행 스트림

## 결정(사용자): 답변이 질문창 위로 쌓이는 채팅형 + 처리 상황 실시간 표시 (클로드/GPT형 UX)

## mind: POST /ask/stream (Bearer 보호 — 바디는 /ask와 동일)
- 응답 `text/event-stream` (requestTimeout=0 유지로 절단 없음):
  - `event: status` `data: {"stage":"...","detail":"..."}` — **파이프라인 실제 마일스톤에서만 발생(가짜 타이머 연출 금지)**
  - `event: envelope` `data: <기존 /ask 봉투 그대로>` — 종결, 정확히 1회
  - `event: error` `data: {"message":"..."}` — 종결
  - 15s 간격 keep-alive 코멘트(`:ka`)
- stage 표준: fast=`route|search|synthesize` / global=`registry|digests|search|synthesize` / deep=`plan|agent:<slug>|contradict|synthesize` / 공통 마지막 `assemble`
- 파이프라인 deps에 `onProgress?: (stage: string, detail?: string) => void` 추가 — 미지정 시 무동작(**기존 /ask·MCP 경로 무변경**)
- 웹은 EventSource가 아니라 **fetch + ReadableStream SSE 파싱**(POST 바디+Authorization 헤더 필요).

## web: 채팅 레이아웃 (web/만, mind/src 계약은 위 스트림뿐)
- 메시지 스레드(위) + 입력창(하단 고정): 사용자 말풍선/코스모스 말풍선, 최신이 아래, 자동 스크롤. 3D 코스모스는 배경으로 계속 보임(반투명 패널).
- 대기 중: 진행 status를 실시간 교체 표시(스피너+단계 텍스트). 완료: 답변 타자기 연출, mode 뱃지(fast/global/deep), 출처·trace 접이식, digest:// 표기 규약 유지.
- 401 시 토큰 재입력 프롬프트(기존 localStorage 방식 유지). Enter=전송, Shift+Enter=줄바꿈.

## M7.5 게이트 (검증=본체)
1. SSE 유닛: status*→envelope 순서, envelope 1회, onProgress 미지정 시 기존 /ask 동일 응답.
2. curl -N 실측: fast·global 각각 status 이벤트가 실제 단계 순서로 흐르고 envelope 종결.
3. 웹 헤드리스 스크린샷 육안: 채팅 배치(답변이 입력창 위), 진행 상태 표시, 답변 렌더.
4. 회귀: 기존 /ask(MCP 포함) 무변경, 전체 테스트 green.

# M8 확장 (2026-07-15) — 지식 PR: 브랜치·머지 + 관리자/사용자 역할

## 결정(사용자 인터뷰): ①팀원=개인별 토큰 발급 ②허브 동기화(메모리·위키·프로젝트 문서)=main 직행 유지 ③기존 인박스(건별 파일 승인)=브랜치로 일원화. 관리자=사용자 본인(기존 COSMOS_TOKEN).

## 개념: main=승인된 공용 코스모스(전 질의 대상). 브랜치=검토 대기 changeset(RSS/arXiv 수집 배치·팀원 업로드), main에서 완전 격리. merge=관리자 전용, 선택 병합(체리픽) 가능, 저널+역연산 롤백. discard=거부(비가역 — 원문 미보관, origin 목록만 저널 기록).

## core: 브랜치 저장·스코프 (Rust)
- DDL: `CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'open', created_by TEXT, created_at TEXT NOT NULL, merged_at TEXT)`. `docs`에 `branch_id TEXT` 추가 — 기동 시 PRAGMA table_info로 부재 시 ALTER(기존 DB 무파괴 마이그레이션), NULL=main.
- **스코프 구현 = 후보 단계 exclusion-set 필터**: 브랜치 문서 doc_id 집합(소규모)을 로드해 BM25·벡터 후보에서 제외. tantivy 스키마 변경·재색인 불요, 벡터 저장소 무변경. merge=재태깅만(재색인 없음).
- 격리 범위(전부 main만): /search, /route, misfit 풀, lifecycle 탄생·병합 판정, /universe, **/entities**(브랜치 문서의 frontmatter entity 미노출 — docs 조인 branch_id IS NULL), /docs 기본 응답.
- 오버레이: SearchRequest에 `include_branch_id?` — 지정 시 해당 브랜치 문서를 후보에 **포함**(관리자 미리보기 질의용).
- ingest: IngestRequest에 요청 단위 `branch_id?` — 지정 시 전 문서 해당 브랜치 태깅(없는 브랜치면 404). duplicate 판정은 origin 전역(같은 origin이 main에 있으면 브랜치에도 duplicate).
- 엔드포인트: `POST /branches {name, created_by?}`(201, 이름 중복 409) / `GET /branches?status=` / `GET /branches/{id}/docs`(DocSummary[]) / `POST /branches/{id}/merge {doc_ids?}`(생략=전체, 응답 {merged, remaining}, 전량 병합 시 status=merged) / `POST /branches/{id}/discard`(문서 삭제+색인 제거, status=discarded).
- 저널: `branch_create` / `branch_merge`(inverse=doc_ids 재태깅 — **롤백 왕복 무손실 필수**) / `branch_discard`(inverse 없음, origins 기록만 — 비가역 명시).

## mind: 사용자·역할 (TS)
- `data/users.json`: [{name, role: "admin"|"member", token_sha256, created_at, revoked_at?}]. env COSMOS_TOKEN=부트스트랩 관리자(name="admin"). 인증 미들웨어: Bearer→sha256→조회→요청에 identity 부착. 미들웨어 실패 규약은 기존 401 유지, 권한 부족=403.
- 권한표: member = /ask·/search·GET /universe·GET /branches·GET /branches/{id}/docs·**POST /ingest는 브랜치 강제**(branch_id 필수, main 직행 403). admin = 전부 + merge/discard/rollback/users CRUD. PC 일일 동기화(scan)는 관리자 토큰 → main 직행 유지(결정 ②).
- CLI: `user add <이름> [--role member]`(토큰 1회 출력, 해시만 저장) / `user list` / `user revoke <이름>`.
- `GET /me` → {name, role} (웹 UI 게이팅용).
- 수집기 일원화(결정 ③): collect 실행 시 점수 필터 통과분을 브랜치 `collect/YYYY-MM-DD`(중복 시 `-2` 접미)로 직접 ingest. 인박스 pending 파일 신규 생성 중단. **기동 시 1회 마이그레이션**: 기존 pending 파일 잔량→브랜치 `inbox-legacy`로 ingest 후 파일 이동(data/inbox/migrated/). /inbox 엔드포인트는 410 Gone+안내 메시지.

## web: 검토 화면
- 챗 패널 헤더에 검토 뱃지(open 브랜치 문서 수 합). 클릭→검토 패널: 브랜치 목록→문서 목록(제목·출처·잠정 클러스터·fit)·체크박스 선택→[선택 병합][브랜치 거부](관리자 버튼, member에겐 숨김 — /me 게이팅). **미리보기 v1=오버레이 검색**(기존 /search 프록시가 include_branch_id를 그대로 전달 — 백엔드 무변경): 질문 입력→해당 브랜치 포함 상위 결과에서 브랜치 문서 하이라이트. 풀 ask 오버레이 미리보기는 백로그(M9).
- /me로 역할 감지. member 화면=질의·열람만.

## M8 게이트 (검증=본체)
1. 격리: 브랜치 ingest 문서가 main /search·/ask·/entities·/universe 전부 미노출, 오버레이 검색에는 노출.
2. 권한: member 토큰 merge/discard/rollback→403, ask/search→200, member ingest에 branch_id 없으면 403. admin 전 경로 200.
3. 병합: 체리픽 부분 병합→선택분만 main ask 인용에 등장, 잔여 브랜치 잔류. **머지 롤백 왕복 무손실**(문서·검색 노출·entities까지 원상).
4. 일원화: collect 실행→자동 브랜치 생성 확인, 레거시 pending 마이그레이션 1회 실증(사본에서), /inbox 410.
5. 생명주기: 브랜치 문서가 misfit·탄생·병합 후보에 불포함(사본 DB 실측).
6. 회귀: 기존 전 테스트 green(core 47+mind 130), M7 global·M7.5 스트림 게이트 재확인.

# M8.5 확장 (2026-07-15) — 자기소멸 초대: 봇 DM 발송 → 첫 인증 시 링크 삭제

## 결정(사용자): 링크 발급→봇이 직접 DM→팀원이 인증하면 DM에서 링크 삭제. 슬랙 봇=store-sentinel 앱 재사용(스코프 im:write·chat:write 확인됨, 워크스페이스 onofferhq).

## mind 구현
- env 신설: `SLACK_BOT_TOKEN`(미설정 시 초대 봇 기능 전체 비활성 — 기존 동작 무변경), `COSMOS_PUBLIC_URL`(초대 링크 베이스, 기본 http://localhost:8800).
- `users.ts`: resolveIdentity 성공 시 해당 유저에 `first_used_at` **write-once** 기록(이미 있으면 무기록 — 매 요청 파일쓰기 방지).
- 신규 `invite.ts`(슬랙 호출=내장 fetch, 의존성 0):
  - `sendInvite(name, slackUserId)`: addUser(재사용, 토큰 확보)→링크 `${PUBLIC_URL}/#token=<토큰>` 조립→`conversations.open`(users=slackUserId)→`chat.postMessage`(DM: 초대 안내+링크+"인증되면 이 메시지는 자동 삭제됩니다")→`data/invites.json`에 {name, slack_user, channel, ts, sent_at, status:"pending"} 기록. 슬랙 실패 시 계정은 생성된 채 토큰을 CLI에 출력(수동 전달 폴백).
  - `checkInvites()`: pending 각각 — ①해당 유저 first_used_at 존재→`chat.delete`(channel, ts)→새 DM "✅ 인증 확인 — 보안을 위해 초대 링크를 삭제했어요"→status:"done" ②sent_at+72h 경과→chat.delete→"⏰ 초대 링크 만료 — 관리자에게 재발급을 요청하세요"→status:"expired"(계정은 유지). 슬랙 호출 실패는 다음 주기 재시도(상태 불변).
- serve 기동 시 SLACK_BOT_TOKEN 있으면 60초 간격 checkInvites 타이머(기존 cron 타이머와 같은 패턴, unref).
- CLI: `invite <이름> <슬랙멤버ID> [--role member]`. tools/invite.ps1은 -SlackId 지정 시 이 CLI로 위임, 미지정 시 기존 수동 흐름(안내문+.url).

## M8.5 게이트
1. 유닛: first_used_at write-once / sendInvite가 invites.json 기록+슬랙 2콜(fake fetch) / checkInvites 3분기(인증→delete+확인DM, 72h→만료, 미인증·미만료→무동작) / SLACK_BOT_TOKEN 미설정 시 타이머 미기동.
2. E2E(실슬랙): 관리자 본인 슬랙 ID로 초대→DM 수신 확인→발급 토큰으로 /me 1회 호출(첫 인증 시뮬)→60s 내 DM의 링크 메시지 삭제+확인 DM 도착.
3. 회귀: 기존 144+ 전 테스트 green.

# M8.6 확장 (2026-07-16) — 관리 콘솔: 관리자 전용 UI + 초대 DM 발송

## 결정(사용자): 관리 UI는 관리자에게만 보이고(멤버는 뱃지조차 미노출), 관리자는 UI에서 초대 DM 발송과 병합 수행.

## mind 엔드포인트 (둘 다 admin 전용 — member 403)
- `GET /slack/users?q=<이름>`: SLACK_BOT_TOKEN으로 users.list 호출(활성·비봇만), real_name/display_name에 q 포함 필터 → [{id, real_name, display_name}]. 토큰 미설정 시 503("슬랙 봇 미구성").
- `POST /invite {name, slack_user_id, role?="member"}`: 기존 invite.ts sendInvite 호출. 성공 {sent:true}, 슬랙 실패 시 {sent:false, token}(관리자 수동 전달용 — 이 경로 외 토큰 HTTP 노출 없음), 이름 중복 409.

## web (review.js — 관리 패널로 승격)
- **role!=="admin"이면 뱃지·패널 전체 미초기화**(멤버 화면에 관리 요소 0). 기존 "member도 열람" 정책 폐기(M8 계약 갱신).
- 패널에 "팀원 초대" 섹션: 이름 입력→[검색]→후보 목록(이름·표시명)→후보 선택→[초대 DM 발송]→결과 한 줄(성공/수동 전달 토큰). 발송 후 입력 초기화.

## M8.6 게이트
1. 유닛: 두 엔드포인트 member 403·admin 통과, slack users 필터(fake fetch), invite 성공/실패 응답 형태, 토큰 미설정 503.
2. 웹: member 토큰 화면에 관리 요소 0(헤드리스 DOM), admin 화면에 초대 섹션 렌더.
3. E2E(Rocky): admin으로 /slack/users?q=<성> → 대상 팀원 단일 매칭. (실 DM 재발송은 생략 — 기존 E2E로 검증됨)
4. 회귀: 기존 149+ 전 테스트 green.

# M9 확장 (2026-07-16) — 지식 소유권: 공통(shared) / 개인(personal)

## 결정(사용자 인터뷰): ①메모리+위키 전부 개인으로 시작(공유 가치 페이지는 지식 PR로 개별 승격) ②팀원 전원 개인 공간 즉시 ③무인증 공개(3D·검색)=공통만, 인증 시 본인 개인 추가 ④기존 5클러스터는 양 스코프 재부트스트랩. 배경: 개인 로컬 정보(폴더 경로·환경)가 전사 공용에 부적합.

## 소유권 모델 (core)
- `docs.owner TEXT`(NULL=공통) + `clusters.owner TEXT`(NULL=공통) — 무파괴 ALTER 마이그레이션.
- **스코프 = 요청 파라미터 `owner_scope`**: `"shared"`(공통만) | `"shared+<name>"`(공통+해당 개인). mind가 identity로 결정해 전달(core는 mind를 신뢰 — 인증 경계는 mind).
- 적용 범위(M8 exclusion-set 확장 — 브랜치 제외 + **스코프 밖 owner 문서 제외**): /search, /route, /entities, /docs, /clusters(개인 클러스터는 in-scope만), /clusters/digests, universe 데이터, misfits, lifecycle 판정. 전부.
- ingest: IngestRequest에 `owner?` — **branch_id와 동시 지정 금지(400)**(개인 공간은 검토 불요). owner 문서는 배정 시 **owner 일치 클러스터에만** argmax(스코프 내 클러스터 부재 시 `personal-<name>` 기본 클러스터 자동 탄생, 저널 cluster_birth).
- scoped bootstrap: /clusters/bootstrap에 `owner?` — 해당 owner 문서만으로 k-means(공통은 owner NULL 문서만). force 시 해당 스코프 클러스터만 재생성.
- lifecycle: 스코프 순회(공통 + 문서 보유 owner 전부) — misfit·탄생·병합 판정이 스코프 내에서만.
- **승격(개인→공통) = 지식 PR 재사용**: 신규 `POST /branches/{id}/docs {doc_ids}` — **owner≠NULL(개인) 문서만** 기존 open 브랜치에 태깅 가능(공통 문서 되돌리기 금지 400). 검토 중엔 브랜치 격리로 본인 검색에서도 잠시 빠짐(의도). merge 시 `branch_id=NULL AND owner=NULL` 동시 전환, branch_merge inverse에 **doc별 이전 owner 기록**(롤백 시 owner 복원 — 왕복 무손실 유지). v1 진입은 API/CLI(웹 승격 UI는 M9.5).

## mind
- identity→owner_scope: admin→`shared+admin`, member→`shared+<이름>`, 무인증(공개 경로)→`shared`. **owner 파라미터는 요청자 본인 이름만 허용**(타인 owner 지정=403).
- 전 core 호출에 owner_scope 스레딩(ask fast/global/deep·search·universe·entities·digests). 공개 경로(/universe·/search·/)는 토큰 없으면 shared, 있으면 본인 스코프.
- scan(일일 동기화): **session 소스 배치와 repo 소스 배치 분리 전송** — session→owner="admin", repo→공통. member 업로드 규칙 갱신: branch_id **또는** owner=본인 중 하나 필수(403 메시지 갱신).
- 다이제스트: 개인 클러스터 다이제스트는 소유자 스코프에서만 생성·반환.

## web
- 개인 클러스터 시각 구분: 라벨 prefix "개인 · " + 구분 스타일(링/톤). 무인증 뷰=공통 성운만, 인증 시 본인 개인 성운 추가.

## 마이그레이션 (본체 실행 — 사본 리허설 후 Rocky)
0. 도구: `cosmos-core migrate-owner --out <dir> [--source-type session] [--owner admin] [--dry-run]` — owner IS NULL인 해당 source_type 전량 태깅, 저널 `owner_migrate` 기록, 모델 로드 불요. 스코프 부트스트랩은 `cosmos-core bootstrap --owner <name>` 또는 `POST /clusters/bootstrap {owner}`.
1. `source_type='session'` 문서 전량 → owner='admin' (규칙이 곧 분류 — 메모리·위키=session).
2. 기존 클러스터 전체 삭제 → 공통 스코프 부트스트랩(owner NULL 문서) + admin 개인 스코프 부트스트랩 → LLM 라벨링 → 다이제스트 재생성. 전 과정 저널 기록.
3. sync-hub 이후 실행분은 자동으로 owner=admin(scan 분리 배치).

## M9 게이트 (검증=본체)
1. 격리: member 토큰·무인증 각각에서 admin 개인 문서·클러스터·엔티티·다이제스트가 search/ask/entities/universe/digests 전부 0 노출.
2. 본인 품질 유지: admin "전체 현황" 28/28 유지(개인 엔티티는 admin에게 보임), 개인+공통 교차 인용 확인.
3. 마이그레이션: session 문서 전량 owner=admin, 양 스코프 클러스터 생성, 저널 기록, 사본 리허설 선행.
4. 승격 왕복: 개인 문서 승격 브랜치→병합→공통 노출(owner NULL)→롤백→개인 복원(owner 복원).
5. member 개인 공간: member 토큰 owner=본인 ingest 성공, 타인 owner 403, 본인 질의에만 등장.
6. 회귀: 전 테스트(core 61+mind 156)+M7 global·M8 브랜치 게이트.

## 지뢰 목록 (구현 시 필수 반영 — docseal 실증 교훈)
- **tantivy QueryParser는 불린 문법 파서** — 자연어 구두점(`:` `"` `?` `-` `(` `)`)이 Syntax Error를 냄 → 질의는 `sanitize_query`(유니코드 문자·숫자·공백만 잔류) 후 파싱.
- **lindera 한국어**: `embed-ko-dic` 계열 feature로 사전 임베드. 빌드 실패 시 베이스 `lindera` 크레이트를 직접 의존성으로 추가하면 해소된 전례.
- **한국어 바이트 슬라이싱 panic**: 모든 오프셋 연산은 문자 경계 정렬(`is_char_boundary` / floor) 후 수행.
- **`unsafe impl Send/Sync` 금지**: axum 상태로 넣는 Engine은 컴파일러가 Send+Sync를 증명해야 함. 안 되면 아키텍처로 풀 것.
- 임베딩·리랭커 모델은 첫 실행 시 네트워크 다운로드(허용됨) → 캐시 디렉터리는 `--models` (기본 `D:\cosmos\models`).
