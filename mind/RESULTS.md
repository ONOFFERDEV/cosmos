# M1 mind(TS) fast Q&A — 실측 결과

## 구현 산출물

CONTRACT.md M1 확장 절 명시 7개 + CLI 진입점, 전부 완료:

| 파일 | 역할 |
|---|---|
| `src/core-client.ts` | cosmos-core(:8801) 타입 클라이언트 — `/health`, `/search`, `/clusters`, `POST /clusters/bootstrap`, `PATCH /clusters/{id}`, `POST /route` |
| `src/llm.ts` | `LlmClient` 추상화 (`claude-cli` 기본 / `api`, `COSMOS_LLM`로 선택) + `completeJson<T>()` |
| `src/router.ts` | `score = centroid_sim + 0.02*min(bm25_hits,10)`, 상위 K=3 + `0.6*top` 상대 임계값, `why` 트레이스 |
| `src/ask.ts` | fast Q&A 파이프라인 — 라우팅 → core 검색 k=8 → 번호 매긴 청크 → LLM 1회 호출 → 3중 가드 → 봉투 조립 → `data/queries.jsonl` 로깅 |
| `src/bootstrap.ts` | `POST /clusters/bootstrap` → LLM 라벨링 → `PATCH /clusters/{id}`, slug 충돌 시 `-2`/`-3` 접미사 |
| `src/server.ts` | `node:http` 포트 8800, `POST /ask` + `GET /health`, 모든 에러는 HTTP 500 + 한국어 메시지로 흡수(프로세스 크래시 없음) |
| `src/cli.ts` | `node dist/cli.js bootstrap\|ask "질문"\|serve [--port 8800]` |

보조 순수 함수 모듈(테스트 대상): `src/guard.ts`(안티할루시네이션 3중 가드), `src/envelope.ts`(응답 봉투 조립 + 소스 재번호), `src/json-extract.ts`(LLM 응답 JSON 추출).

런타임 npm 의존성 0 — `node:http`, `node:child_process`, `node:fs/promises`, `node:path`, 전역 `fetch`만 사용. devDependency는 `typescript`, `@types/node`뿐.

## 타입체크 & 빌드 (2026-07-13 재실행)

```
$ npx tsc --noEmit
(출력 없음, 종료 코드 0)

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
(종료 코드 0)
```

`dist/` 산출물 14개 (`.js` 전부, 소스맵 제외):
```
dist/ask.js
dist/bootstrap.js
dist/cli.js
dist/core-client.js
dist/envelope.js
dist/envelope.test.js
dist/guard.js
dist/guard.test.js
dist/json-extract.js
dist/json-extract.test.js
dist/llm.js
dist/router.js
dist/router.test.js
dist/server.js
```

## 단위 테스트 (`node --test "dist/**/*.test.js"`, Node v24.16.0)

과제 명세가 요구한 4개 카테고리를 각각 별도 `*.test.ts`로 작성:
(a) 라우터 K/스킵 경계, (b) 봉투 조립(소스 재번호 + trace), (c) 안티할루시네이션 3중 가드의 트리거 3개 개별 검증, (d) JSON 추출 파서(코드펜스·잡담·중첩 중괄호).

전체 실행 결과(29건 전부 통과, 인용):

```
✔ numberSources: 인용된 청크만 등장 순서대로 1..n 재번호를 매긴다 (1.2615ms)
✔ numberSources: 인용되지 않은 청크는 sources에서 빠진다 (0.5831ms)
✔ renderAnswer: 문장 텍스트와 인용 번호를 이어붙인다 (0.154ms)
✔ renderAnswer: 인용 없는 문장은 번호 없이 그대로 붙는다 (0.0616ms)
✔ assembleEnvelope: 정상 응답이면 재번호 매긴 sources와 trace를 포함한다 (0.1523ms)
✔ assembleEnvelope: insufficient면 BLOCK_MESSAGE를 answer로 사용한다 (0.0714ms)
✔ assembleEnvelope: insufficientAnswer가 주어지면 BLOCK_MESSAGE 대신 사용한다 (0.0812ms)
✔ 트리거 (c): 검색 결과가 없으면(null) LLM 호출을 생략한다 (0.5052ms)
✔ 트리거 (c): rerank_score가 음수면 LLM 호출을 생략한다 (0.0712ms)
✔ 트리거 (c): rerank_score가 정확히 0.0이면 호출을 생략하지 않는다 (경계값) (0.0539ms)
✔ 트리거 (c): rerank_score가 양수면 호출을 생략하지 않는다 (0.1194ms)
✔ 트리거 (a): LLM이 insufficient=true를 선언하면 인용이 있어도 insufficient (0.0964ms)
✔ 트리거 (b): 문장이 하나도 없으면 insufficient (0.0572ms)
✔ 트리거 (b): 모든 문장의 cites가 비어있으면 insufficient (0.074ms)
✔ 정상 사례: 인용이 하나라도 있으면 insufficient가 아니다 (0.0528ms)
✔ BLOCK_MESSAGE는 비어있지 않은 한국어 문자열이다 (0.1249ms)
✔ 순수 JSON 문자열을 파싱한다 (1.1953ms)
✔ json 태그 코드펜스 안의 JSON을 추출한다 (0.2293ms)
✔ 태그 없는 코드펜스 안의 JSON을 추출한다 (0.1513ms)
✔ 전후 잡담 텍스트가 섞여 있어도 JSON을 추출한다 (0.7144ms)
✔ 중첩된 중괄호를 올바르게 처리한다 (0.1523ms)
✔ JSON 객체가 없으면 에러를 던진다 (0.1796ms)
✔ 중괄호가 닫히지 않으면 에러를 던진다 (0.0873ms)
✔ 빈 입력이면 빈 배열을 반환한다 (0.9263ms)
✔ computeRouteScore는 bm25_hits를 10으로 캡하고 0.02 가중치를 곱한다 (0.1173ms)
✔ 상위 K=3은 consulted, 그 밖 순위는 top K 밖 사유로 skipped (0.2918ms)
✔ 상위 K 이내라도 score < 0.6*top이면 skipped로 강등한다 (0.7438ms)
✔ 정확히 0.6*top 경계값은 consulted로 처리한다 (>=) (0.16ms)
✔ consultedClusterIds는 consulted 항목의 cluster_id만 추출한다 (0.1572ms)
ℹ tests 29
ℹ suites 0
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 312.4254
```

`npm test`(빌드 + 테스트 통합 스크립트)로도 동일하게 29 pass / 0 fail 재확인.

## claude.exe 경로 해석 (독립 실행, 실제 CLI 호출 없음)

`resolveClaudeExePath()`를 단독 호출한 결과: `C:\Users\User\.local\bin\claude.exe` (`where.exe claude`로 `.cmd`가 아닌 `.exe`를 정확히 선택).

과제 명세에 따라 core 서버(:8801) 대상 실제 E2E, 실제 `claude` CLI 호출은 이번 검증 범위에서 제외했다(관리/게이트 검증은 task #14 본체 담당 — `tools/eval_ask.mjs`가 mind 서버(:8800) 기동 후 즉시 실행 가능하도록 이미 완성되어 있음을 확인).

## 편차 / 설계 결정 기록

- **Node v24.16.0 `node --test` 글롭 이슈**: `node --test dist`(또는 `./dist`)가 디렉터리를 단일 모듈로 `require()` 시도해 `MODULE_NOT_FOUND`로 실패함을 발견. 명시적 글롭 문자열 `node --test "dist/**/*.test.js"`로 우회(따옴표로 셸 사전 확장 방지, PowerShell/cmd.exe 이식성도 확보). `package.json`의 `test` 스크립트를 이 글롭 형태로 수정.
- **`guard.ts` 함수 분리**: 안티할루시네이션 3중 가드 중 트리거 (c)(검색 rerank_score 미달/부재)는 LLM 호출 **이전**에 진짜 단락(short-circuit)이 가능해야 하므로 `shouldSkipLlmCall()`로 분리했고, 트리거 (a)/(b)(LLM 자체 insufficient 선언, 인용 전무)는 LLM 응답이 있어야 판정 가능하므로 `evaluateInsufficient()`로 분리했다. 하나의 함수로 합치면 (c)의 단락 이점이 사라지므로 이 분리는 CONTRACT.md 스펙 위반이 아니라 스펙을 정확히 만족시키기 위한 구현 세부사항이다.
- **`envelope.ts`의 `answer` 문자열**: 스펙은 `answer`가 "[n] 인용 포함 전체 답변 텍스트"라고만 명시하고 생성 방식은 규정하지 않아, `sentences[].text` + `cites`로부터 결정적으로 조립하는 `renderAnswer()`를 내부에 두어 LLM이 별도로 전체 텍스트를 생성할 필요가 없게 했다(중복 생성으로 인한 문장-인용 불일치 가능성을 원천 차단).
- **`ask.ts`의 `cluster_ids` 생략**: `SearchRequest`에 스코프 클러스터가 없을 때(consulted 클러스터가 0개인 경우는 이론상 없지만, 방어적으로) 빈 배열 대신 필드 자체를 생략하도록 했다 — openapi.yaml에서 해당 필드가 optional이므로 core 쪽 빈 배열 처리 분기에 의존하지 않기 위함.

## 블로커

없음. 내 담당 범위(`mind/` 전체, 이 태스크 스펙에 명시된 7개 산출물 + `cli.ts`)는 전부 완료·검증되었다. core 서버(:8801) 기동 후의 `/ask` 실제 E2E 측정(긍정/부정 문항 게이트)은 task #14(본체 담당)의 선행 조건이며, 이번 태스크 스펙은 core/실 LLM 대상 E2E를 명시적으로 검증 범위 밖으로 규정했다.

## M2

M2 스코프: `D:\cosmos\mind` + 신규 `D:\cosmos\cosmos.config.json`만 생성·수정, `core/`·`contract/`·`tools/`는 무수정.

### 구현 산출물

CONTRACT.md "# M2 확장" 절 명시 항목 전부 완료:

| 파일 | 역할 |
|---|---|
| `D:\cosmos\cosmos.config.json` | arXiv 카테고리 5종, RSS 피드 4개(실존 검증된 2개만 `enabled:true`), 프로파일 키워드 20개 내외(가중치 포함), `max_pending_per_run:20`, `watcher.dirs`(메모리+위키 절대경로)+`interval_secs:60`, `policy` 기본값 |
| `src/config.ts` | `cosmos.config.json` 로더 + 스키마 검증(`CosmosConfig`, `defaultConfigPath()`, `defaultDataDir()`) |
| `src/collect.ts` | arXiv Atom API 수집(카테고리별 max, 커서 `data/collect.state.json`) + RSS/Atom 최소 파서(`parseFeed` — RSS `<item>` 우선, 없으면 Atom `<entry>` 폴백, 실패 피드 경고 후 스킵) → 프로파일 점수(제목 2×·본문 1×) → 상위 N건 `data/inbox/pending/{id}.json` 생성. LLM 무사용, 순수 함수와 오케스트레이션 분리 |
| `src/inbox.ts` | pending 목록 로드·표 렌더(`listPending`/`renderPendingTable`), `approveOne`/`approveMany`/`approveAll`(core `/ingest` 호출 성공 시에만 `approved/`로 이동 + `cluster_slug`/`fit` 기록), `rejectOne`/`rejectMany`(ingest 미호출, `rejected/`로 이동) |
| `src/watcher.ts` | 폴링 스캐너 — `isWatchedFile`/`listMarkdownFiles`(재귀, `_templates/` 디렉토리 통째 스킵) → `scanOnce`(매칭 파일 0건이면 ingest 미호출, 있으면 벌크 1회 `source_type=session`) → `startWatcherLoop`(setInterval + `busy` 가드 + `unref()`) |
| `src/cli.ts` | `collect`/`inbox`/`approve <id...>\|--all`/`reject <id...>`/`scan`/`ingest <경로\|URL> [--type manual]` 서브커맨드 추가, `runManualIngest`(로컬 `.md`/`.txt` 또는 URL fetch→`<script>`/`<style>` 제거+태그 스트립→core 즉시 ingest) |
| `src/server.ts` | `GET /inbox`, `POST /inbox/{id}/approve`, `POST /inbox/{id}/reject`(실패 시 HTTP 409) 라우트 추가 |

승인 게이트(이번 마일스톤 핵심 요구): `collect.ts`는 `core.ingest`를 단 한 번도 직접 호출하지 않는다 — pending 파일 기록까지만 수행한다. `core.ingest` 호출은 `inbox.ts`의 `approveOne`/`approveMany`/`approveAll` 경로에서만, 그리고 `watcher.ts`(session, 자동)와 `cli.ts`의 manual ingest(직접) 경로에서만 발생한다. `inbox.test.ts`의 "pending 생성 시점에는 core.ingest가 0회 호출된다" 테스트로 이 불변조건을 직접 증명했다(아래 단위 테스트 절 참조).

런타임 npm 의존성 0 유지 — 신규 코드도 `node:http`, `node:fs/promises`, `node:path`, `node:crypto`, `node:os`, 전역 `fetch`만 사용.

### 타입체크 & 빌드

```
$ npx tsc --noEmit
(출력 없음, 종료 코드 0)

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
(종료 코드 0)
```

### 단위 테스트 (`npm test` = `npm run build && node --test "dist/**/*.test.js"`, Node v24.16.0)

과제 명세가 요구한 (a)~(f) 6개 카테고리를 신규 3개 파일(`collect.test.ts`/`inbox.test.ts`/`watcher.test.ts`, 총 22건)로 커버:
(a) arXiv Atom 픽스처 파싱, (b) RSS 픽스처 파싱+CDATA/태그 스트립(+Atom 폴백), (c) 프로파일 점수·상위 N 컷, (d) inbox 상태 전이 — **mock `CoreClient` 호출 기록으로 "pending 생성 시점 ingest 0회"를 직접 단언**, (e) 워처 제외 규칙(`_templates/` 디렉토리 통째 스킵 포함), (f) 커서 갱신(`advanceCursor` 불변성 포함). 전 항목 네트워크·실 core 무접촉(mock/픽스처/임시 디렉토리만 사용).

전체 실행 결과(51건 전부 통과 — 기존 M0/M1 29건 + 신규 M2 22건, 회귀 0건, 인용):

```
✔ parseArxivAtom은 entry 블록에서 id/title/authors/summary/published를 추출한다 (1.7327ms)
✔ parseFeed는 RSS item 블록을 파싱하고 CDATA+HTML 태그를 스트립한다 (0.7218ms)
✔ parseFeed는 RSS item이 없으면 Atom entry로 폴백한다 (0.2251ms)
✔ scoreText는 제목 2배·본문 1배 가중치로 매칭 키워드를 집계한다 (0.1348ms)
✔ selectTopCandidates는 점수 내림차순 정렬 후 상위 N개만 반환한다 (0.1124ms)
✔ cutUnseen은 lastSeenId 이전 항목만 남긴다(신규순 정렬 가정) (0.166ms)
✔ advanceCursor는 새 커서로 상태를 갱신하되 원본은 불변으로 둔다 (0.0839ms)
✔ stripHtmlTags는 script/style을 제거하고 태그를 벗긴다 (0.0737ms)
✔ truncate는 max 길이를 넘으면 자른다 (8.1885ms)
✔ candidateId는 origin의 sha256 앞 12자를 반환하고 결정론적이다 (0.5517ms)
✔ extractTag는 속성이 있는 태그도 대소문자 무시하고 추출한다 (0.0958ms)
✔ decodeXmlEntities는 이름 엔티티와 숫자 엔티티를 모두 디코딩한다 (0.097ms)
✔ numberSources: 인용된 청크만 등장 순서대로 1..n 재번호를 매긴다 (1.3424ms)
✔ numberSources: 인용되지 않은 청크는 sources에서 빠진다 (0.8168ms)
✔ renderAnswer: 문장 텍스트와 인용 번호를 이어붙인다 (0.1628ms)
✔ renderAnswer: 인용 없는 문장은 번호 없이 그대로 붙는다 (0.151ms)
✔ assembleEnvelope: 정상 응답이면 재번호 매긴 sources와 trace를 포함한다 (0.4084ms)
✔ assembleEnvelope: insufficient면 BLOCK_MESSAGE를 answer로 사용한다 (0.1675ms)
✔ assembleEnvelope: insufficientAnswer가 주어지면 BLOCK_MESSAGE 대신 사용한다 (0.0926ms)
✔ 트리거 (c): 검색 결과가 없으면(null) LLM 호출을 생략한다 (0.5016ms)
✔ 트리거 (c): rerank_score가 음수면 LLM 호출을 생략한다 (0.0995ms)
✔ 트리거 (c): rerank_score가 정확히 0.0이면 호출을 생략하지 않는다 (경계값) (0.1124ms)
✔ 트리거 (c): rerank_score가 양수면 호출을 생략하지 않는다 (0.0819ms)
✔ 트리거 (a): LLM이 insufficient=true를 선언하면 인용이 있어도 insufficient (0.0994ms)
✔ 트리거 (b): 문장이 하나도 없으면 insufficient (0.0561ms)
✔ 트리거 (b): 모든 문장의 cites가 비어있으면 insufficient (0.1204ms)
✔ 정상 사례: 인용이 하나라도 있으면 insufficient가 아니다 (0.0596ms)
✔ BLOCK_MESSAGE는 비어있지 않은 한국어 문자열이다 (0.1254ms)
✔ pending 생성 시점에는 core.ingest가 0회 호출된다 (31.6298ms)
✔ approveOne은 core.ingest를 정확히 1회 호출하고 approved/로 이동시키며 cluster_slug/fit을 기록한다 (436.7081ms)
✔ rejectOne은 core.ingest를 호출하지 않고 rejected/로 이동시킨다 (494.3758ms)
✔ approveMany은 존재하지 않는 id를 격리하고 유효한 id만 ingest를 호출한다 (328.9713ms)
✔ approveOne은 ingest가 실패하면 pending 파일을 그대로 남겨둔다(부분 실패 격리) (196.028ms)
✔ renderPendingTable은 빈 배열에 안내 문구를 반환한다 (0.2092ms)
✔ 순수 JSON 문자열을 파싱한다 (1.1469ms)
✔ json 태그 코드펜스 안의 JSON을 추출한다 (0.2157ms)
✔ 태그 없는 코드펜스 안의 JSON을 추출한다 (0.1491ms)
✔ 전후 잡담 텍스트가 섞여 있어도 JSON을 추출한다 (0.6725ms)
✔ 중첩된 중괄호를 올바르게 처리한다 (0.1673ms)
✔ JSON 객체가 없으면 에러를 던진다 (0.2141ms)
✔ 중괄호가 닫히지 않으면 에러를 던진다 (0.0978ms)
✔ 빈 입력이면 빈 배열을 반환한다 (0.9462ms)
✔ computeRouteScore는 bm25_hits를 10으로 캡하고 0.02 가중치를 곱한다 (0.2494ms)
✔ 상위 K=3은 consulted, 그 밖 순위는 top K 밖 사유로 skipped (0.3254ms)
✔ 상위 K 이내라도 score < 0.6*top이면 skipped로 강등한다 (0.9469ms)
✔ 정확히 0.6*top 경계값은 consulted로 처리한다 (>=) (0.7328ms)
✔ consultedClusterIds는 consulted 항목의 cluster_id만 추출한다 (1.0929ms)
✔ isWatchedFile은 제외 파일명을 걸러내고 .md만 허용한다 (0.4815ms)
✔ listMarkdownFiles는 재귀적으로 .md를 찾고 _templates 디렉토리는 건너뛴다 (42.564ms)
✔ scanOnce는 매칭된 파일을 core.ingest에 벌크로 1회 전송하고 결과를 집계한다 (4.7542ms)
✔ scanOnce는 매칭된 파일이 없으면 core.ingest를 호출하지 않는다 (0.5018ms)
ℹ tests 51
ℹ suites 0
ℹ pass 51
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2921.6851
```

### arXiv 실 API 스모크 테스트 (1회, 승인 없이 확인 후 삭제)

`runCollect()`를 `config.collect.arxiv.categories=["cs.CL"]`, `max_per_category=3`, `rss.feeds=[]`로 제한하고 실 데이터 디렉토리(`D:\cosmos\data`)에 대해 1회 실행:

```json
{
  "written": 3,
  "consideredArxiv": 3,
  "consideredRss": 0,
  "skippedExisting": 0,
  "cutByCap": 0,
  "failedFeeds": []
}
```

`D:\cosmos\data\inbox\pending\`에 3개 JSON 파일(`2d6551f1da67.json`, `d02ebf5c5a48.json`, `d4df3f9bec42.json`)이 CONTRACT.md pending 스키마 그대로 생성됨을 확인(예: "Agora: Enhancing LLM Agent Reasoning..." 항목이 `llm`/`agent`/`language model` 키워드에 매칭되어 `score:20`). **어떤 항목도 approve하지 않았음** — 확인 직후 3개 파일과 이 실행으로 신규 생성된 `data/collect.state.json` 커서 파일을 전부 삭제해 실 데이터 디렉토리를 스모크 테스트 이전 상태로 복원했다(삭제 전/후 `ls` 결과로 대조 확인). RSS/실 core `/ingest` 대상 E2E는 이번 검증 범위 밖(관리자 몫)이며 실행하지 않았다.

### 편차 / 설계 결정 기록

- **워처 재귀 스캔 + `_templates/` 디렉토리 스킵**: CONTRACT.md는 `watcher.dirs`를 스캔 대상으로만 규정하고 재귀 여부는 명시하지 않는다. 메모리 폴더가 `_ontology.md` 같은 온톨로지 파일 외에 하위 디렉토리(예: 프로젝트별 서브폴더가 생길 가능성)를 가질 수 있어 재귀 스캔을 채택했다. 단, `_templates/`는 커맨드 템플릿 보관용이라 실제 지식이 아니므로 디렉토리 자체를 통째로 스킵(하위 진입 없음)하도록 `EXCLUDED_DIR_NAMES`로 별도 처리했다. M0의 비재귀 스캔 패턴과는 다른 선택이지만, `watcher.dirs`에 지정되는 대상(메모리·위키 루트)의 실제 구조를 반영한 것으로 CONTRACT.md 위반은 아니다.
- **arXiv URL 스킴 https vs 문서상 http**: CONTRACT.md 본문 예시는 `http://export.arxiv.org/api/query`를 언급하지만, 실 arXiv Atom API는 http 요청을 https로 리다이렉트한다(리다이렉트를 따르면 동작은 하지만 추가 왕복이 발생하고, `fetchImpl` 목으로 테스트할 때도 스킴 불일치가 생긴다). 구현은 `https://export.arxiv.org/...`를 직접 사용하도록 결정했다 — 스모크 테스트에서 3건 모두 정상 수신되어 확인됨. 이 편차는 실제 API 엔드포인트의 정확한 프로토콜을 반영한 것이며 기능적으로 CONTRACT.md 의도(카테고리별 최신 논문 수집)를 정확히 만족한다.
- **기본 활성 RSS 피드**: `hnrss.org/newest`(HN 키워드 필터)와 `blog.cloudflare.com/rss/` 2개만 `enabled:true`로 시드했다(이전 세션에서 WebFetch로 실존·응답 확인 완료). Figma 블로그·OpenAI 블로그 피드는 URL 포맷 확신이 없어 `enabled:false` 예시로만 남겼다 — 활성화는 실존 확인 후 설정 파일만 수정하면 되므로 관리자가 손쉽게 확장 가능하다.

### 블로커

없음. 스코프(`mind/` + `cosmos.config.json`) 내 6개 구현 항목(설정 파일, collect.ts, inbox.ts, watcher.ts, manual ingest, CLI/HTTP 확장) 전부 완료·검증됨. RSS 피드 실제 파싱 결과 및 실 core `/ingest` 연동 E2E(승인 후 클러스터 배정까지 포함하는 전체 흐름)는 core 서버(:8801) 기동이 선행되어야 하므로 이번 검증 범위 밖이며 관리자 몫이다.

## M3

M3 스코프: `D:\cosmos\mind`만 생성·수정. `core/`·`contract/`·`tools/`·`data/`는 무수정 — core 변경 없음, 기존 `/route`·클러스터 스코프 `/search` 엔드포인트를 그대로 재사용한다.

### 구현 산출물

CONTRACT.md M3 확장 절(175-237행) 명시 항목 전부 완료:

| 파일 | 역할 |
|---|---|
| `src/llm.ts` (확장) | `complete`/`completeJson`에 호출별 `model?: "sonnet"\|"opus"` 파라미터 추가(기본 `"sonnet"`). `ClaudeCliLlmClient`는 `--model` CLI 인자로, `ApiLlmClient`는 `API_MODEL_MAP`으로 반영 |
| `src/envelope.ts` (확장) | `mode: "fast"\|"deep"` 필드, `TraceEntry`에 `subquestion?`/`claims?`(consulted 전용), `Cost`에 `stages?: Record<string, number>` 추가 — 전부 additive, 기존 fast 경로 스키마·동작 불변 |
| `src/deep.ts` (신규, 637줄) | deep 협의 파이프라인 — 플래너(Opus 1콜, 커버리지 자동 보정 + K≤4 예산 컷) → 클러스터 에이전트(Sonnet, `Promise.all` 병렬, 클러스터 스코프 `/search` k=8 → 인용 없는 claim 드랍 → 파싱 실패 시 `completeJson` 자체 재시도 1회) → 모순 감지(Opus 종합-1) → (모순 있을 때만) 반박 라운드(최대 1회) → 종합-2 → 봉투 조립(전역 소스 재번호, trace 완전성, `cost.llm_calls`/`cost.stages` 집계) → 전 브리프 claims 합계 0이면 종합 LLM 호출 자체를 생략하고 차단 → 프로세스 전역 뮤텍스(동시 1건, 미충족 시 즉시 거부) |
| `src/server.ts` (확장) | `POST /ask`에 `mode:"deep"` 분기 — `runDeepAsk` 호출, 뮤텍스 충돌 시 HTTP 429 + 한국어 메시지, 그 외 예외는 기존 500 처리로 흡수 |
| `src/cli.ts` (확장) | `ask "질문" [--deep]` — `--deep` 플래그 검출 시 `runDeepAsk`로 분기, 플래그는 질문 문자열에서 제거 후 조립 |

`src/ask.ts`의 `appendQueryLog`는 `mode`/`trace`/`cost` 필드를 그대로 통과시키는 범용 구현이라 **코드 변경 없이** deep 모드 로깅을 그대로 지원함을 재확인(기존 스펙 5번 항목).

런타임 npm 의존성 0 유지 — 신규 코드도 `node:http`, `node:fs/promises`, `node:path`, `node:os`, 전역 `fetch`만 사용.

### 타입체크 & 빌드

```
$ npx tsc --noEmit
(출력 없음, 종료 코드 0)

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
(종료 코드 0)
```

### 단위 테스트 (`npm test` = `npm run build && node --test "dist/**/*.test.js"`, Node v24.16.0)

과제 명세가 요구한 (a)~(h) 8개 시나리오를 신규 `deep.test.ts`(8건)로 커버:
(a) 플래너 커버리지 자동 보정(응답 누락 클러스터 → skipped 처리, 원인 문구 확정), (b) K>4 예산 컷(라우팅 점수 내림차순 재정렬 검증, 입력 순서와 무관), (c) 브리프 파싱 — 인용 없는/범위 밖 claim 드랍(6건 중 2건만 생존), (d) 모순 없음 → 종합 LLM 콜 정확히 1회, (e) 모순 발견 → 반박 1회(양측 클러스터 각 1콜) + 종합 2회, (f) 전 브리프 claims 합계 0 → 종합 콜 0회로 즉시 차단, (g) 전역 소스 재번호(클러스터 간 청크 오프셋 합산 + 등장순 재매핑) + trace 완전성(consulted/skipped 전 항목), (h) 프로세스 전역 뮤텍스 — 동시 2건 중 1건은 `DEEP_BUSY_MESSAGE`로 즉시 거부. 전 항목 mock `CoreClient`/`LlmClient`(프롬프트 내 고유 한국어 마커로 호출 종류 판별)만 사용, 실 core·실 LLM 무접촉. `runDeepAsk`를 호출하는 모든 테스트는 `mkdtemp`로 임시 `dataDir`를 지정해 `appendQueryLog`가 스코프 밖(`D:\cosmos\data`)에 쓰지 않도록 격리.

전체 실행 결과(59건 전부 통과 — 기존 M0/M1/M2 51건 + 신규 M3 8건, 회귀 0건, 인용):

```
✔ parseArxivAtom은 entry 블록에서 id/title/authors/summary/published를 추출한다 (2.2138ms)
✔ parseFeed는 RSS item 블록을 파싱하고 CDATA+HTML 태그를 스트립한다 (0.8141ms)
✔ parseFeed는 RSS item이 없으면 Atom entry로 폴백한다 (0.2282ms)
✔ scoreText는 제목 2배·본문 1배 가중치로 매칭 키워드를 집계한다 (0.2315ms)
✔ selectTopCandidates는 점수 내림차순 정렬 후 상위 N개만 반환한다 (0.1328ms)
✔ cutUnseen은 lastSeenId 이전 항목만 남긴다(신규순 정렬 가정) (0.7677ms)
✔ advanceCursor는 새 커서로 상태를 갱신하되 원본은 불변으로 둔다 (0.1145ms)
✔ stripHtmlTags는 script/style을 제거하고 태그를 벗긴다 (0.063ms)
✔ truncate는 max 길이를 넘으면 자른다 (0.0821ms)
✔ candidateId는 origin의 sha256 앞 12자를 반환하고 결정론적이다 (0.4012ms)
✔ extractTag는 속성이 있는 태그도 대소문자 무시하고 추출한다 (0.0734ms)
✔ decodeXmlEntities는 이름 엔티티와 숫자 엔티티를 모두 디코딩한다 (0.0877ms)
✔ (a) 플래너 응답에서 누락된 active 클러스터는 자동으로 skipped 처리된다 (0.9181ms)
✔ (b) 참여 클러스터가 예산(K=4)을 초과하면 라우팅 점수 상위 4개만 남긴다 (0.1884ms)
✔ (c) cites가 없거나 유효하지 않은 claim은 드랍된다 (0.1391ms)
✔ (d) 모순이 없으면 종합 콜은 1회만 실행된다 (7.3668ms)
✔ (e) 모순 발견 시 반박 1회 + 종합 2회가 실행된다 (2.4175ms)
✔ (f) 전 브리프 claims 합계가 0이면 종합 콜 없이 차단된다 (2.1307ms)
✔ (g) 전역 재번호와 trace 완전성을 갖춘 봉투를 조립한다 (2.6172ms)
✔ (h) 뮤텍스: 동시에 실행 중인 deep 요청이 있으면 두 번째 호출은 즉시 거부된다 (2.5645ms)
✔ numberSources: 인용된 청크만 등장 순서대로 1..n 재번호를 매긴다 (1.2515ms)
✔ numberSources: 인용되지 않은 청크는 sources에서 빠진다 (0.7012ms)
✔ renderAnswer: 문장 텍스트와 인용 번호를 이어붙인다 (0.1191ms)
✔ renderAnswer: 인용 없는 문장은 번호 없이 그대로 붙는다 (0.0618ms)
✔ assembleEnvelope: 정상 응답이면 재번호 매긴 sources와 trace를 포함한다 (0.165ms)
✔ assembleEnvelope: insufficient면 BLOCK_MESSAGE를 answer로 사용한다 (0.0667ms)
✔ assembleEnvelope: insufficientAnswer가 주어지면 BLOCK_MESSAGE 대신 사용한다 (0.0693ms)
✔ 트리거 (c): 검색 결과가 없으면(null) LLM 호출을 생략한다 (0.4749ms)
✔ 트리거 (c): rerank_score가 음수면 LLM 호출을 생략한다 (0.0666ms)
✔ 트리거 (c): rerank_score가 정확히 0.0이면 호출을 생략하지 않는다 (경계값) (0.053ms)
✔ 트리거 (c): rerank_score가 양수면 호출을 생략하지 않는다 (0.1012ms)
✔ 트리거 (a): LLM이 insufficient=true를 선언하면 인용이 있어도 insufficient (0.095ms)
✔ 트리거 (b): 문장이 하나도 없으면 insufficient (0.0539ms)
✔ 트리거 (b): 모든 문장의 cites가 비어있으면 insufficient (0.0804ms)
✔ 정상 사례: 인용이 하나라도 있으면 insufficient가 아니다 (0.0521ms)
✔ BLOCK_MESSAGE는 비어있지 않은 한국어 문자열이다 (0.1974ms)
✔ pending 생성 시점에는 core.ingest가 0회 호출된다 (7.9402ms)
✔ approveOne은 core.ingest를 정확히 1회 호출하고 approved/로 이동시키며 cluster_slug/fit을 기록한다 (7.3683ms)
✔ rejectOne은 core.ingest를 호출하지 않고 rejected/로 이동시킨다 (6.074ms)
✔ approveMany은 존재하지 않는 id를 격리하고 유효한 id만 ingest를 호출한다 (5.6283ms)
✔ approveOne은 ingest가 실패하면 pending 파일을 그대로 남겨둔다(부분 실패 격리) (3.893ms)
✔ renderPendingTable은 빈 배열에 안내 문구를 반환한다 (0.2001ms)
✔ 순수 JSON 문자열을 파싱한다 (1.3343ms)
✔ json 태그 코드펜스 안의 JSON을 추출한다 (0.2797ms)
✔ 태그 없는 코드펜스 안의 JSON을 추출한다 (0.1832ms)
✔ 전후 잡담 텍스트가 섞여 있어도 JSON을 추출한다 (0.7659ms)
✔ 중첩된 중괄호를 올바르게 처리한다 (0.1817ms)
✔ JSON 객체가 없으면 에러를 던진다 (0.2346ms)
✔ 중괄호가 닫히지 않으면 에러를 던진다 (0.0991ms)
✔ 빈 입력이면 빈 배열을 반환한다 (0.761ms)
✔ computeRouteScore는 bm25_hits를 10으로 캡하고 0.02 가중치를 곱한다 (0.1448ms)
✔ 상위 K=3은 consulted, 그 밖 순위는 top K 밖 사유로 skipped (0.3725ms)
✔ 상위 K 이내라도 score < 0.6*top이면 skipped로 강등한다 (0.7073ms)
✔ 정확히 0.6*top 경계값은 consulted로 처리한다 (>=) (0.1221ms)
✔ consultedClusterIds는 consulted 항목의 cluster_id만 추출한다 (0.1081ms)
✔ isWatchedFile은 제외 파일명을 걸러내고 .md만 허용한다 (0.5583ms)
✔ listMarkdownFiles는 재귀적으로 .md를 찾고 _templates 디렉토리는 건너뛴다 (10.0759ms)
✔ scanOnce는 매칭된 파일을 core.ingest에 벌크로 1회 전송하고 결과를 집계한다 (8.8026ms)
✔ scanOnce는 매칭된 파일이 없으면 core.ingest를 호출하지 않는다 (0.8737ms)
ℹ tests 59
ℹ suites 0
ℹ pass 59
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 280.4767
```

### 편차 / 설계 결정 기록

- **모순 공개는 LLM 프롬프트 신뢰에 의존**: 반박 라운드 후에도 남는 미해결 상충을 종합-2가 "상충 근거" 단락으로 반드시 노출하도록 프롬프트에 명시했지만, 이는 코드로 강제되는 불변조건이 아니라 LLM의 지시 준수에 의존한다. CONTRACT.md가 반박은 "최대 1회"로만 규정하고 그 이후 잔여 모순의 처리 방식을 코드 레벨로 강제하라고 요구하지 않으므로, 이 설계는 스펙 위반이 아니라 스펙이 열어둔 재량 범위 내의 선택이다.
- **뮤텍스는 큐잉이 아니라 즉시 거부**: `deep.ts` 모듈 스코프의 `boolean` 플래그로 구현했다 — 동시 요청이 오면 대기열에 넣지 않고 즉시 `DEEP_BUSY_MESSAGE`로 거부한다(HTTP 429). CONTRACT.md는 "프로세스 전역 동시 1건 뮤텍스로 직렬화"라고만 명시하고 큐잉 여부는 규정하지 않는다. deep 파이프라인이 다중 LLM 콜을 포함해 수초~수십초가 소요될 수 있어, 대기열 방식은 요청자에게 응답 지연을 숨기는 대신 타임아웃 관리·대기열 크기 제한 등 추가 복잡도를 요구한다. 즉시 거부는 구현이 단순하고, 클라이언트(서버 핸들러)가 429를 받아 재시도 여부를 스스로 결정할 수 있어 CONTRACT.md의 의도(동시 1건 보장)를 정확히 만족한다.
- **반박 라운드의 상대측 주장은 원시 문자열로 전달**: `runClusterRebuttal`은 상충하는 상대 클러스터의 주장을 `cites: []`인 가짜 `BriefClaim` 객체로 감싸지 않고, `Contradiction.a_claim`/`b_claim` 텍스트를 그대로 문자열 배열(`opposingClaims: string[]`)로 전달한다. 반박 프롬프트는 상대 주장의 인용 출처가 아니라 주장 내용 자체에 대한 반박을 요구하므로, 존재하지 않는 인용을 가진 가짜 객체를 만드는 것보다 이 편이 데이터 모델을 정직하게 유지한다.
- **`stages` 필드 구성**: `planner`/`cluster_agents`/`rebuttal`/`synthesis_1`은 항상 포함하고(모순 없는 경로에서는 `rebuttal`이 `0`), `synthesis_2`는 반박 라운드가 실제로 실행된 경우에만 추가한다 — envelope.ts의 사전 확정 스키마 주석과 정확히 일치시킨 결과다.

### 블로커

없음. 내 담당 범위(`mind/` 전체 — `llm.ts`/`envelope.ts` 확장, `deep.ts` 신규, `server.ts`/`cli.ts` 트리거 배선, `deep.test.ts` 8개 시나리오)는 전부 완료·검증되었다. 실 LLM(`claude` CLI 또는 Anthropic API)과 실 core 서버(:8801)를 대상으로 한 deep 모드 E2E 측정(A/B 평가 하네스 포함, task #28·#29)은 이번 태스크 스펙이 명시적으로 검증 범위 밖으로 규정한 본체·별도 executor 담당이다.

## M3 수정 라운드 1

M3 게이트 1차 실측(관리자 진단)에서 발견된 타임아웃 결함 2건 수정. 스코프: `D:\cosmos\mind` + `D:\cosmos\tools\eval_deep.mjs`만 수정, `core/`·`contract/` 무수정. 정본은 CONTRACT.md "## LLM 타임아웃 규격"(2026-07-13 개정) — 그대로 구현.

### 실측 증상

1. deep `/ask` 전량 500: `llm.ts`의 고정 120s 타임아웃이 Opus 플래너 호출에 부족(Sonnet도 fast에서 122.8s 실측 전례).
2. `eval_deep.mjs`의 fast 호출 3건이 하네스 자체 AbortError — fetch AbortController 타임아웃이 실제 fast 지연(최대 123s+)보다 짧음.

### 구현 산출물

| 파일 | 변경 |
|---|---|
| `src/llm.ts` | 고정 `CLAUDE_CLI_TIMEOUT_MS=120_000` 상수 제거 → `DEFAULT_TIMEOUT_MS: Record<ModelAlias, number>`(sonnet 180_000 / opus 420_000) + `TIMEOUT_ENV_VAR` 맵 + 신규 export `resolveTimeoutMs(model)`(env `COSMOS_LLM_TIMEOUT_SONNET_MS`/`COSMOS_LLM_TIMEOUT_OPUS_MS`가 양의 유한수로 파싱되면 그 값, 아니면 모델별 기본값). `ClaudeCliLlmClient.complete()`는 이 함수로 타임아웃을 모델별로 산출하도록 변경(기존 `setTimeout`+`child.kill()` 구조는 유지, 상수만 동적화). `ApiLlmClient.complete()`는 이전에 타임아웃 강제가 전혀 없었던 것을 `AbortController` 기반으로 신규 추가(CLI 클라이언트와 동일한 에러 메시지 포맷: 모델명 + 적용 ms 포함). |
| `src/deep.ts` | `runDeepAskInner`의 단계 전이 지점에 순수 `console.log` 4종 추가(로직 변경 없음, 기존 `elapsed()` 계산값 재사용): `[deep] 플래너 시작` / `[deep] 플래너 완료(N.Ns)`, `[deep] 에이전트 K개 병렬 시작` / `[deep] 에이전트 K개 병렬 완료(N.Ns)`, `[deep] 반박 라운드`(모순 발견 시에만), `[deep] 종합 완료(N.Ns)`(종합-1 단독 종료 시/종합-2 종료 시 각각 1회). |
| `tools/eval_deep.mjs` | `FAST_TIMEOUT_MS` 기본값 300_000(기존보다 상향), `DEEP_TIMEOUT_MS` 기본값 900_000으로 변경(둘 다 기존처럼 env override 가능, 값만 상향). `askOne()`이 `AbortError`를 감지해 `하네스 타임아웃(${mode} ${Math.round(timeoutMs/1000)}s) for ${question.id}` 형태로 재던지도록 변경 — 초 단위는 실제 `timeoutMs` 파라미터에서 동적 계산(하드코딩 아님, env override 시에도 메시지 정확). `CLUSTER_SEARCH_TIMEOUT_MS`(무관한 헬퍼 `searchClusterOrigins` 전용)는 스코프 밖이라 무수정. |
| `src/llm.test.ts` (신규) | `resolveTimeoutMs` 유닛 테스트 3건: (a) 오버라이드 없을 때 모델별 기본값(sonnet 180000 / opus 420000), (b) env 오버라이드가 있으면 그 값 사용, (c) 오버라이드가 파싱 불가(비숫자 문자열) 또는 무효(음수)일 때 기본값으로 폴백. |

### 타입체크 & 빌드

```
$ npx tsc --noEmit
(출력 없음, 종료 코드 0)

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
(종료 코드 0)
```

### 단위 테스트 (`node --test "dist/**/*.test.js"`, Node v24.16.0)

기존 59건 + 신규 `llm.test.ts` 3건 = 62건 전부 통과(회귀 0건), 인용:

```
✔ parseArxivAtom은 entry 블록에서 id/title/authors/summary/published를 추출한다 (1.6126ms)
✔ parseFeed는 RSS item 블록을 파싱하고 CDATA+HTML 태그를 스트립한다 (0.6116ms)
✔ parseFeed는 RSS item이 없으면 Atom entry로 폴백한다 (0.1817ms)
✔ scoreText는 제목 2배·본문 1배 가중치로 매칭 키워드를 집계한다 (0.1203ms)
✔ selectTopCandidates는 점수 내림차순 정렬 후 상위 N개만 반환한다 (0.0913ms)
✔ cutUnseen은 lastSeenId 이전 항목만 남긴다(신규순 정렬 가정) (0.5458ms)
✔ advanceCursor는 새 커서로 상태를 갱신하되 원본은 불변으로 둔다 (0.1019ms)
✔ stripHtmlTags는 script/style을 제거하고 태그를 벗긴다 (0.0586ms)
✔ truncate는 max 길이를 넘으면 자른다 (0.0821ms)
✔ candidateId는 origin의 sha256 앞 12자를 반환하고 결정론적이다 (0.4096ms)
✔ extractTag는 속성이 있는 태그도 대소문자 무시하고 추출한다 (0.0646ms)
✔ decodeXmlEntities는 이름 엔티티와 숫자 엔티티를 모두 디코딩한다 (0.075ms)
✔ (a) 플래너 응답에서 누락된 active 클러스터는 자동으로 skipped 처리된다 (0.9265ms)
✔ (b) 참여 클러스터가 예산(K=4)을 초과하면 라우팅 점수 상위 4개만 남긴다 (0.1791ms)
✔ (c) cites가 없거나 유효하지 않은 claim은 드랍된다 (0.1322ms)
✔ (d) 모순이 없으면 종합 콜은 1회만 실행된다 (7.304ms)
✔ (e) 모순 발견 시 반박 1회 + 종합 2회가 실행된다 (2.2001ms)
✔ (f) 전 브리프 claims 합계가 0이면 종합 콜 없이 차단된다 (1.6923ms)
✔ (g) 전역 재번호와 trace 완전성을 갖춘 봉투를 조립한다 (1.6964ms)
✔ (h) 뮤텍스: 동시에 실행 중인 deep 요청이 있으면 두 번째 호출은 즉시 거부된다 (2.204ms)
✔ numberSources: 인용된 청크만 등장 순서대로 1..n 재번호를 매긴다 (1.1394ms)
✔ numberSources: 인용되지 않은 청크는 sources에서 빠진다 (0.7657ms)
✔ renderAnswer: 문장 텍스트와 인용 번호를 이어붙인다 (0.1591ms)
✔ renderAnswer: 인용 없는 문장은 번호 없이 그대로 붙는다 (0.0854ms)
✔ assembleEnvelope: 정상 응답이면 재번호 매긴 sources와 trace를 포함한다 (0.2255ms)
✔ assembleEnvelope: insufficient면 BLOCK_MESSAGE를 answer로 사용한다 (0.1447ms)
✔ assembleEnvelope: insufficientAnswer가 주어지면 BLOCK_MESSAGE 대신 사용한다 (0.1132ms)
✔ 트리거 (c): 검색 결과가 없으면(null) LLM 호출을 생략한다 (0.7986ms)
✔ 트리거 (c): rerank_score가 음수면 LLM 호출을 생략한다 (0.1165ms)
✔ 트리거 (c): rerank_score가 정확히 0.0이면 호출을 생략하지 않는다 (경계값) (0.1532ms)
✔ 트리거 (c): rerank_score가 양수면 호출을 생략하지 않는다 (0.1111ms)
✔ 트리거 (a): LLM이 insufficient=true를 선언하면 인용이 있어도 insufficient (0.1015ms)
✔ 트리거 (b): 문장이 하나도 없으면 insufficient (0.0563ms)
✔ 트리거 (b): 모든 문장의 cites가 비어있으면 insufficient (0.1325ms)
✔ 정상 사례: 인용이 하나라도 있으면 insufficient가 아니다 (0.0703ms)
✔ BLOCK_MESSAGE는 비어있지 않은 한국어 문자열이다 (0.2555ms)
✔ pending 생성 시점에는 core.ingest가 0회 호출된다 (8.3388ms)
✔ approveOne은 core.ingest를 정확히 1회 호출하고 approved/로 이동시키며 cluster_slug/fit을 기록한다 (7.5626ms)
✔ rejectOne은 core.ingest를 호출하지 않고 rejected/로 이동시킨다 (5.3837ms)
✔ approveMany은 존재하지 않는 id를 격리하고 유효한 id만 ingest를 호출한다 (5.0255ms)
✔ approveOne은 ingest가 실패하면 pending 파일을 그대로 남겨둔다(부분 실패 격리) (4.2048ms)
✔ renderPendingTable은 빈 배열에 안내 문구를 반환한다 (0.1621ms)
✔ 순수 JSON 문자열을 파싱한다 (1.0549ms)
✔ json 태그 코드펜스 안의 JSON을 추출한다 (0.2544ms)
✔ 태그 없는 코드펜스 안의 JSON을 추출한다 (0.1716ms)
✔ 전후 잡담 텍스트가 섞여 있어도 JSON을 추출한다 (0.762ms)
✔ 중첩된 중괄호를 올바르게 처리한다 (0.1689ms)
✔ JSON 객체가 없으면 에러를 던진다 (0.1681ms)
✔ 중괄호가 닫히지 않으면 에러를 던진다 (0.075ms)
✔ 모델별 기본 타임아웃: sonnet=180000ms, opus=420000ms (0.6588ms)
✔ env 오버라이드가 있으면 그 값을 사용한다 (0.2007ms)
✔ env 오버라이드 파싱 실패 시 모델별 기본값으로 폴백한다 (0.1566ms)
✔ 빈 입력이면 빈 배열을 반환한다 (0.9783ms)
✔ computeRouteScore는 bm25_hits를 10으로 캡하고 0.02 가중치를 곱한다 (0.1379ms)
✔ 상위 K=3은 consulted, 그 밖 순위는 top K 밖 사유로 skipped (0.5196ms)
✔ 상위 K 이내라도 score < 0.6*top이면 skipped로 강등한다 (0.6942ms)
✔ 정확히 0.6*top 경계값은 consulted로 처리한다 (>=) (0.1821ms)
✔ consultedClusterIds는 consulted 항목의 cluster_id만 추출한다 (0.1468ms)
✔ isWatchedFile은 제외 파일명을 걸러내고 .md만 허용한다 (0.7507ms)
✔ listMarkdownFiles는 재귀적으로 .md를 찾고 _templates 디렉토리는 건너뛴다 (10.1145ms)
✔ scanOnce는 매칭된 파일을 core.ingest에 벌크로 1회 전송하고 결과를 집계한다 (6.0855ms)
✔ scanOnce는 매칭된 파일이 없으면 core.ingest를 호출하지 않는다 (0.7149ms)
ℹ tests 62
ℹ suites 0
ℹ pass 62
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1552.4118
```

deep 단계 로그(`[deep] ...`)가 `deep.test.ts`의 mock 파이프라인 실행 중 실제로 콘솔에 출력됨을 위 로그에서 확인(플래너/에이전트 병렬/반박/종합 4종 전부 등장) — 신규 로깅이 배선상 정확히 동작함을 유닛 테스트 부산물로도 재확인.

### `tools/eval_deep.mjs` 문법 검사

```
$ node --check eval_deep.mjs
(출력 없음, 종료 코드 0)
```

### 편차 / 설계 결정 기록

- **하네스 타임아웃 메시지의 초 단위는 동적 계산**: CONTRACT.md 예시 문구는 "하네스 타임아웃(fast 300s)" 식이지만, 구현은 `Math.round(timeoutMs / 1000)`으로 실제 적용된 `timeoutMs`(env `COSMOS_FAST_TIMEOUT_MS`/`COSMOS_DEEP_TIMEOUT_MS`로 오버라이드된 경우 포함)에서 초 단위를 계산해 넣는다. "300s"/"900s"를 문자열 리터럴로 하드코딩하지 않은 것은 편차가 아니라, env 오버라이드 시에도 에러 메시지가 실제 타임아웃 값과 항상 일치하도록 보장하기 위한 구현 세부사항이다.
- **`CLUSTER_SEARCH_TIMEOUT_MS` 무수정**: `eval_deep.mjs`에 존재하는 이 상수(`searchClusterOrigins` 헬퍼 전용, 클러스터 출처 검색과 무관한 별개 기능)는 CONTRACT.md의 fast/deep ask 타임아웃 규격 대상이 아니므로 30_000ms 그대로 두었다 — 스코프 확장을 피하기 위함.

### 블로커

없음. 지시된 3개 파일 수정(`llm.ts`/`deep.ts`/`eval_deep.mjs`) + 신규 유닛 테스트(`llm.test.ts`) 전부 완료·검증되었다. 실 LLM 호출(`claude` CLI/API)과 실 게이트 재실행(수정된 타임아웃값으로 실제 deep `/ask` 및 `eval_deep.mjs` 재측정)은 이번 태스크 스펙이 명시적으로 관리자/본체 담당으로 규정했으므로 수행하지 않았다.

## M3 수정 라운드 2

M3 게이트 2차 실측(관리자 진단)에서 발견된 소켓 절단·진단 불가 결함 수정. 스코프: `D:\cosmos\mind` + `D:\cosmos\tools`(eval_deep.mjs·judge_deep 계열만)만 수정, `core/`·`contract/` 무수정. 정본은 CONTRACT.md "## 서버 소켓·진단 규격" — 그대로 구현.

### 실측 증상

1. Node `http` 기본 `requestTimeout`(300s)이 deep 장시간 응답(최대 900s) 소켓을 절단 → 클라이언트 측 "fetch failed"로 관측됨(서버는 정상 처리 중이었으나 소켓이 먼저 끊김).
2. qd01 문항의 `/ask` 500 응답이 서버 콘솔에 원인을 전혀 남기지 않아(에러 삼킴) 어느 파이프라인 단계(플래너/에이전트/반박/종합)에서 실패했는지 사후 진단이 불가능했음.

### 구현 산출물

| 파일 | 변경 |
|---|---|
| `src/server.ts` | `createMindServer()`에서 `server.requestTimeout = 0;`(비활성화, CONTRACT.md 규격 그대로) 설정 직후 `console.log("requestTimeout=0")` 추가(유닛 테스트로 검증하기 어려운 설정이므로 콘솔 로그로 증거 확보). `handleAsk()`의 `mode`(`"fast"`/`"deep"`)를 try 블록 밖에 선언해 catch에서도 접근 가능하게 하고, 500 응답 직전에 `console.error("[ask-error]", mode, err instanceof Error ? err.stack ?? err.message : err)`를 추가해 에러를 삼키지 않고 콘솔에 스택+모드를 남긴다. |
| `src/deep.ts` | 신규 헬퍼 `withStage<T>(stage: string, fn: () => Promise<T>): Promise<T>` 추가 — `fn()`을 실행하다 에러가 나면 메시지에 `[deep:<stage>]` 프리픽스를 붙인 새 `Error`로 재던지고, 원본 스택을 새 에러의 `.stack` 앞에 이어붙여 보존한다. 플래너 호출·클러스터 에이전트 병렬 호출(각각 `` agent:${sub.cluster_slug} ``)·반박 호출·종합-1/종합-2 호출을 전부 이 헬퍼로 감쌌다(로직 변경 없음, 에러 발생 시 단계 식별용 프리픽스만 추가). 팀리드 스펙의 "플래너/에이전트:<slug>/반박/종합" 표기를 그대로 따라 `"planner"`, `` `agent:${slug}` ``, `"rebuttal"`, `"synthesis"` 4종 단계명을 사용했다. |

### 타입체크 & 빌드

```
$ npx tsc --noEmit
(출력 없음)
EXIT_CODE=0

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
BUILD_EXIT=0
```

### 단위 테스트 (`node --test "dist/**/*.test.js"`, Node v24.16.0)

기존 62건 전부 통과(회귀 0건), `withStage` 래핑 후에도 deep 파이프라인 8개 시나리오((a)~(h))가 그대로 동작함을 재확인. 인용:

```
✔ parseArxivAtom은 entry 블록에서 id/title/authors/summary/published를 추출한다 (1.6126ms)
✔ parseFeed는 RSS item 블록을 파싱하고 CDATA+HTML 태그를 스트립한다 (0.6116ms)
✔ parseFeed는 RSS item이 없으면 Atom entry로 폴백한다 (0.1817ms)
✔ scoreText는 제목 2배·본문 1배 가중치로 매칭 키워드를 집계한다 (0.1203ms)
✔ selectTopCandidates는 점수 내림차순 정렬 후 상위 N개만 반환한다 (0.0913ms)
✔ cutUnseen은 lastSeenId 이전 항목만 남긴다(신규순 정렬 가정) (0.5458ms)
✔ advanceCursor는 새 커서로 상태를 갱신하되 원본은 불변으로 둔다 (0.1019ms)
✔ stripHtmlTags는 script/style을 제거하고 태그를 벗긴다 (0.0586ms)
✔ truncate는 max 길이를 넘으면 자른다 (0.0821ms)
✔ candidateId는 origin의 sha256 앞 12자를 반환하고 결정론적이다 (0.4096ms)
✔ extractTag는 속성이 있는 태그도 대소문자 무시하고 추출한다 (0.0646ms)
✔ decodeXmlEntities는 이름 엔티티와 숫자 엔티티를 모두 디코딩한다 (0.075ms)
✔ (a) 플래너 응답에서 누락된 active 클러스터는 자동으로 skipped 처리된다 (0.9265ms)
✔ (b) 참여 클러스터가 예산(K=4)을 초과하면 라우팅 점수 상위 4개만 남긴다 (0.1791ms)
✔ (c) cites가 없거나 유효하지 않은 claim은 드랍된다 (0.1322ms)
✔ (d) 모순이 없으면 종합 콜은 1회만 실행된다 (7.304ms)
✔ (e) 모순 발견 시 반박 1회 + 종합 2회가 실행된다 (2.2001ms)
✔ (f) 전 브리프 claims 합계가 0이면 종합 콜 없이 차단된다 (1.6923ms)
✔ (g) 전역 재번호와 trace 완전성을 갖춘 봉투를 조립한다 (1.6964ms)
✔ (h) 뮤텍스: 동시에 실행 중인 deep 요청이 있으면 두 번째 호출은 즉시 거부된다 (2.204ms)
✔ numberSources: 인용된 청크만 등장 순서대로 1..n 재번호를 매긴다 (1.1394ms)
✔ numberSources: 인용되지 않은 청크는 sources에서 빠진다 (0.7657ms)
✔ renderAnswer: 문장 텍스트와 인용 번호를 이어붙인다 (0.1591ms)
✔ renderAnswer: 인용 없는 문장은 번호 없이 그대로 붙는다 (0.0854ms)
✔ assembleEnvelope: 정상 응답이면 재번호 매긴 sources와 trace를 포함한다 (0.2255ms)
✔ assembleEnvelope: insufficient면 BLOCK_MESSAGE를 answer로 사용한다 (0.1447ms)
✔ assembleEnvelope: insufficientAnswer가 주어지면 BLOCK_MESSAGE 대신 사용한다 (0.1132ms)
✔ 트리거 (c): 검색 결과가 없으면(null) LLM 호출을 생략한다 (0.7986ms)
✔ 트리거 (c): rerank_score가 음수면 LLM 호출을 생략한다 (0.1165ms)
✔ 트리거 (c): rerank_score가 정확히 0.0이면 호출을 생략하지 않는다 (경계값) (0.1532ms)
✔ 트리거 (c): rerank_score가 양수면 호출을 생략하지 않는다 (0.1111ms)
✔ 트리거 (a): LLM이 insufficient=true를 선언하면 인용이 있어도 insufficient (0.1015ms)
✔ 트리거 (b): 문장이 하나도 없으면 insufficient (0.0563ms)
✔ 트리거 (b): 모든 문장의 cites가 비어있으면 insufficient (0.1325ms)
✔ 정상 사례: 인용이 하나라도 있으면 insufficient가 아니다 (0.0703ms)
✔ BLOCK_MESSAGE는 비어있지 않은 한국어 문자열이다 (0.2555ms)
✔ pending 생성 시점에는 core.ingest가 0회 호출된다 (8.3388ms)
✔ approveOne은 core.ingest를 정확히 1회 호출하고 approved/로 이동시키며 cluster_slug/fit을 기록한다 (7.5626ms)
✔ rejectOne은 core.ingest를 호출하지 않고 rejected/로 이동시킨다 (5.3837ms)
✔ approveMany은 존재하지 않는 id를 격리하고 유효한 id만 ingest를 호출한다 (5.0255ms)
✔ approveOne은 ingest가 실패하면 pending 파일을 그대로 남겨둔다(부분 실패 격리) (4.2048ms)
✔ renderPendingTable은 빈 배열에 안내 문구를 반환한다 (0.1621ms)
✔ 순수 JSON 문자열을 파싱한다 (1.0549ms)
✔ json 태그 코드펜스 안의 JSON을 추출한다 (0.2544ms)
✔ 태그 없는 코드펜스 안의 JSON을 추출한다 (0.1716ms)
✔ 전후 잡담 텍스트가 섞여 있어도 JSON을 추출한다 (0.762ms)
✔ 중첩된 중괄호를 올바르게 처리한다 (0.1689ms)
✔ JSON 객체가 없으면 에러를 던진다 (0.1681ms)
✔ 중괄호가 닫히지 않으면 에러를 던진다 (0.075ms)
✔ 모델별 기본 타임아웃: sonnet=180000ms, opus=420000ms (0.6588ms)
✔ env 오버라이드가 있으면 그 값을 사용한다 (0.2007ms)
✔ env 오버라이드 파싱 실패 시 모델별 기본값으로 폴백한다 (0.1566ms)
✔ 빈 입력이면 빈 배열을 반환한다 (0.9783ms)
✔ computeRouteScore는 bm25_hits를 10으로 캡하고 0.02 가중치를 곱한다 (0.1379ms)
✔ 상위 K=3은 consulted, 그 밖 순위는 top K 밖 사유로 skipped (0.5196ms)
✔ 상위 K 이내라도 score < 0.6*top이면 skipped로 강등한다 (0.6942ms)
✔ 정확히 0.6*top 경계값은 consulted로 처리한다 (>=) (0.1821ms)
✔ consultedClusterIds는 consulted 항목의 cluster_id만 추출한다 (0.1468ms)
✔ isWatchedFile은 제외 파일명을 걸러내고 .md만 허용한다 (0.7507ms)
✔ listMarkdownFiles는 재귀적으로 .md를 찾고 _templates 디렉토리는 건너뛴다 (10.1145ms)
✔ scanOnce는 매칭된 파일을 core.ingest에 벌크로 1회 전송하고 결과를 집계한다 (6.0855ms)
✔ scanOnce는 매칭된 파일이 없으면 core.ingest를 호출하지 않는다 (0.7149ms)
ℹ tests 62
ℹ suites 0
ℹ pass 62
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1552.4118
```

### `requestTimeout=0` 적용 증거

유닛 테스트로 `http.Server.requestTimeout` 값을 직접 검증하기 어려워(실 소켓 필요), 팀리드 지시대로 설정 직후 콘솔 로그로 증거를 남겼다. 코드상 `server.requestTimeout = 0;` 다음 줄에 `console.log("requestTimeout=0");`가 위치해 실 서버 기동 시(`cli.ts`의 `createMindServer(...).listen(...)`) 항상 출력된다 — `src/server.ts:33-34` 참고.

### 편차 / 설계 결정 기록

- **`console.error`는 `handleAsk`의 catch에만 추가**: `handleRequest`를 감싸는 최상위 방어선(`createMindServer`의 `.catch()`)에는 별도 로깅을 추가하지 않았다. 팀리드 스펙이 "/ask 예외를 500으로 바꿀 때" 로깅을 명시했고, 최상위 방어선은 `/ask` 외 다른 경로(`/inbox` 등)까지 포괄하는 이미 존재하던 다른 방어선이라 스코프 밖으로 판단했다.
- **`withStage` 단계명**: 팀리드가 예시로 든 "플래너/에이전트:<slug>/반박/종합" 표기를 코드 식별자로 그대로 옮겨 `"planner"`, `` `agent:${slug}` ``(예: `agent:multi-agent-workflow-lessons`), `"rebuttal"`, `"synthesis"`(종합-1/종합-2 공통, 라운드 구분은 에러 메시지에 없으나 스택 트레이스의 호출 위치로 구분 가능) 4종으로 확정했다. 종합을 라운드별로 `synthesis_1`/`synthesis_2`로 더 세분화하지 않은 이유는 팀리드 스펙이 "종합" 단수 표기만 요구했고, 과도한 세분화는 스코프 확장이라 판단했기 때문이다.
- **에러 스택 보존 방식**: `withStage`는 새 `Error`를 만들되 원본 `err.stack`을 새 에러의 `.stack` 앞에 이어붙여(`` `${wrapped.message}\n${err.stack}` ``), `console.error("[ask-error]", mode, err.stack ?? err.message)`가 단계 프리픽스와 원본 스택을 모두 한 번에 출력하도록 했다 — 원본 스택을 버리지 않으면서 단계 정보만 추가하는 방식.

### 블로커

없음. 지시된 2개 파일 수정(`server.ts`/`deep.ts`) 전부 완료·검증되었다(기존 62건 회귀 없음). `requestTimeout=0` 설정과 `[ask-error]` 로깅이 실제 소켓 절단/500 상황에서 의도대로 동작하는지의 실 서버 E2E 재현(장시간 deep 호출로 300s 이상 걸리는 실측, qd01 500 재현)은 관리자/team-lead 레인의 실 서버 기동·측정 담당으로 이번 태스크 스펙이 명시했으므로 수행하지 않았다.

## M3 수정 라운드 3

M3 게이트 3차 실측(관리자 진단)에서 발견된 동시성·클라이언트측 타임아웃 결함 수정. 스코프: `D:\cosmos\mind` + `D:\cosmos\tools\eval_deep.mjs`만 수정, `core/`·`contract/` 무수정. 정본은 CONTRACT.md "## LLM 타임아웃 규격" 절의 3차 실측 개정 3개 항목 — 그대로 구현.

### 실측 증상

1. deep 에이전트 3~4개가 동시에 `claude` CLI를 spawn하면 공유 레이트리밋 풀에서 개별 호출이 지연되어, sonnet 기본 타임아웃 180s를 초과하는 사례가 확인됨(qd02).
2. Node `fetch`(undici)가 자체 `headersTimeout`(기본 300s)을 갖고 있어, 서버 `requestTimeout=0`으로 무제한 대기하도록 설정해도 5분을 넘는 deep 응답을 **클라이언트 쪽**에서 먼저 절단함 — qd01/qd04의 "fetch failed" 실패와 qd03(272s, 통과)·qd05(306s, 경계에서 통과) 실측치가 이 가설과 정합.

### 구현 산출물

| 파일 | 변경 |
|---|---|
| `src/llm.ts` | `DEFAULT_TIMEOUT_MS.sonnet`을 `180_000` → `360_000`으로 상향(opus `420_000` 유지). env 오버라이드 로직(`resolveTimeoutMs`)은 무수정. 상수 옆 주석에 3차 실측 근거(레이트리밋 풀 지연)를 기록. |
| `src/llm.test.ts` | 타임아웃 기본값 테스트의 sonnet 기대값을 `180000` → `360000`으로 갱신. |
| `src/deep.ts` | 신규 상수 `DEEP_AGENT_CONCURRENCY = 2`와 헬퍼 `mapWithConcurrencyLimit<T, R>(items, limit, fn)` 추가 — 외부 의존성 없이 공유 커서(`nextIndex`) 기반 워커 풀로 구현, 완료 순서와 무관하게 결과를 원본 인덱스에 기록해 순서를 보존한다. 클러스터 에이전트 실행을 `Promise.all(selected.map(...))` 전체 병렬에서 `mapWithConcurrencyLimit(selected, DEEP_AGENT_CONCURRENCY, ...)`로 교체. 단계 로그를 `` `[deep] 에이전트 ${n}개(동시 2) 시작/완료` `` 형태로 갱신. |
| `src/deep.test.ts` | 신규 테스트 "(i) 클러스터 에이전트 풀은 동시 2개를 초과하지 않고, 브리프-클러스터 매핑 순서를 보존한다" 추가 — mock `LlmClient`에 동시 실행 카운터를 심어 최대 동시 호출 수가 2를 넘지 않음을 단언하고, 4개 클러스터 브리프의 결과가 원본 `selected` 순서와 정확히 일치함을 단언. |
| `tools/eval_deep.mjs` | `/ask` 호출을 `fetch`에서 `node:http` `request()` 직접 구현으로 교체 — POST JSON(UTF-8), 자체 타임아웃(fast 300_000ms · deep 1_200_000ms)을 `req.setTimeout(timeoutMs, ...)` + `settled` 플래그 가드로 구현(`llm.ts`의 `ClaudeCliLlmClient`와 동일 패턴), 타임아웃 시 "하네스 타임아웃(...)" 에러 메시지 유지, 비-2xx 응답은 본문을 포함해 에러로 던지는 기존 동작 유지. `/health`·`/docs` 등 짧은 호출은 `fetch` 그대로 둠. |

### 타입체크 & 빌드

```
$ npx tsc --noEmit
(출력 없음)
TSC_EXIT=0

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
BUILD_EXIT=0
```

### 단위 테스트 (`node --test "dist/**/*.test.js"`, Node v24.16.0)

기존 62건 전부 통과(회귀 0건) + 신규 (i) 1건 추가 = 총 63건 전부 통과. 신규 로그 포맷(`에이전트 N개(동시 2) 시작/완료`)이 (d)~(h) 전 시나리오에서 배선상 정확히 출력됨을 확인. 인용:

```
✔ parseArxivAtom은 entry 블록에서 id/title/authors/summary/published를 추출한다 (1.8448ms)
✔ parseFeed는 RSS item 블록을 파싱하고 CDATA+HTML 태그를 스트립한다 (1.0285ms)
✔ parseFeed는 RSS item이 없으면 Atom entry로 폴백한다 (0.3289ms)
✔ scoreText는 제목 2배·본문 1배 가중치로 매칭 키워드를 집계한다 (0.1486ms)
✔ selectTopCandidates는 점수 내림차순 정렬 후 상위 N개만 반환한다 (0.0961ms)
✔ cutUnseen은 lastSeenId 이전 항목만 남긴다(신규순 정렬 가정) (0.7171ms)
✔ advanceCursor는 새 커서로 상태를 갱신하되 원본은 불변으로 둔다 (0.2206ms)
✔ stripHtmlTags는 script/style을 제거하고 태그를 벗긴다 (0.1095ms)
✔ truncate는 max 길이를 넘으면 자른다 (0.1241ms)
✔ candidateId는 origin의 sha256 앞 12자를 반환하고 결정론적이다 (0.5288ms)
✔ extractTag는 속성이 있는 태그도 대소문자 무시하고 추출한다 (0.088ms)
✔ decodeXmlEntities는 이름 엔티티와 숫자 엔티티를 모두 디코딩한다 (0.0833ms)
✔ (a) 플래너 응답에서 누락된 active 클러스터는 자동으로 skipped 처리된다 (1.4501ms)
✔ (b) 참여 클러스터가 예산(K=4)을 초과하면 라우팅 점수 상위 4개만 남긴다 (0.3271ms)
✔ (c) cites가 없거나 유효하지 않은 claim은 드랍된다 (0.2561ms)
✔ (d) 모순이 없으면 종합 콜은 1회만 실행된다 (13.8244ms)
✔ (e) 모순 발견 시 반박 1회 + 종합 2회가 실행된다 (4.5209ms)
✔ (f) 전 브리프 claims 합계가 0이면 종합 콜 없이 차단된다 (6.4204ms)
✔ (g) 전역 재번호와 trace 완전성을 갖춘 봉투를 조립한다 (5.9002ms)
✔ (h) 뮤텍스: 동시에 실행 중인 deep 요청이 있으면 두 번째 호출은 즉시 거부된다 (3.6434ms)
✔ (i) 클러스터 에이전트 풀은 동시 2개를 초과하지 않고, 브리프-클러스터 매핑 순서를 보존한다 (46.7594ms)
✔ numberSources: 인용된 청크만 등장 순서대로 1..n 재번호를 매긴다 (1.2802ms)
✔ numberSources: 인용되지 않은 청크는 sources에서 빠진다 (0.7836ms)
✔ renderAnswer: 문장 텍스트와 인용 번호를 이어붙인다 (0.1301ms)
✔ renderAnswer: 인용 없는 문장은 번호 없이 그대로 붙는다 (0.0623ms)
✔ assembleEnvelope: 정상 응답이면 재번호 매긴 sources와 trace를 포함한다 (0.289ms)
✔ assembleEnvelope: insufficient면 BLOCK_MESSAGE를 answer로 사용한다 (0.1827ms)
✔ assembleEnvelope: insufficientAnswer가 주어지면 BLOCK_MESSAGE 대신 사용한다 (0.1102ms)
✔ 트리거 (c): 검색 결과가 없으면(null) LLM 호출을 생략한다 (0.7569ms)
✔ 트리거 (c): rerank_score가 음수면 LLM 호출을 생략한다 (0.1275ms)
✔ 트리거 (c): rerank_score가 정확히 0.0이면 호출을 생략하지 않는다 (경계값) (0.0793ms)
✔ 트리거 (c): rerank_score가 양수면 호출을 생략하지 않는다 (0.1097ms)
✔ 트리거 (a): LLM이 insufficient=true를 선언하면 인용이 있어도 insufficient (0.1564ms)
✔ 트리거 (b): 문장이 하나도 없으면 insufficient (0.0768ms)
✔ 트리거 (b): 모든 문장의 cites가 비어있으면 insufficient (0.091ms)
✔ 정상 사례: 인용이 하나라도 있으면 insufficient가 아니다 (0.0716ms)
✔ BLOCK_MESSAGE는 비어있지 않은 한국어 문자열이다 (0.1575ms)
✔ pending 생성 시점에는 core.ingest가 0회 호출된다 (9.9299ms)
✔ approveOne은 core.ingest를 정확히 1회 호출하고 approved/로 이동시키며 cluster_slug/fit을 기록한다 (8.3157ms)
✔ rejectOne은 core.ingest를 호출하지 않고 rejected/로 이동시킨다 (8.034ms)
✔ approveMany은 존재하지 않는 id를 격리하고 유효한 id만 ingest를 호출한다 (13.1818ms)
✔ approveOne은 ingest가 실패하면 pending 파일을 그대로 남겨둔다(부분 실패 격리) (4.7901ms)
✔ renderPendingTable은 빈 배열에 안내 문구를 반환한다 (0.2041ms)
✔ 순수 JSON 문자열을 파싱한다 (1.477ms)
✔ json 태그 코드펜스 안의 JSON을 추출한다 (0.295ms)
✔ 태그 없는 코드펜스 안의 JSON을 추출한다 (0.2133ms)
✔ 전후 잡담 텍스트가 섞여 있어도 JSON을 추출한다 (0.7497ms)
✔ 중첩된 중괄호를 올바르게 처리한다 (0.1511ms)
✔ JSON 객체가 없으면 에러를 던진다 (0.3684ms)
✔ 중괄호가 닫히지 않으면 에러를 던진다 (0.1867ms)
✔ 모델별 기본 타임아웃: sonnet=360000ms, opus=420000ms (1.0382ms)
✔ env 오버라이드가 있으면 그 값을 사용한다 (0.1558ms)
✔ env 오버라이드 파싱 실패 시 모델별 기본값으로 폴백한다 (0.0954ms)
✔ 빈 입력이면 빈 배열을 반환한다 (0.8078ms)
✔ computeRouteScore는 bm25_hits를 10으로 캡하고 0.02 가중치를 곱한다 (0.1192ms)
✔ 상위 K=3은 consulted, 그 밖 순위는 top K 밖 사유로 skipped (0.2824ms)
✔ 상위 K 이내라도 score < 0.6*top이면 skipped로 강등한다 (0.7175ms)
✔ 정확히 0.6*top 경계값은 consulted로 처리한다 (>=) (0.1354ms)
✔ consultedClusterIds는 consulted 항목의 cluster_id만 추출한다 (0.1728ms)
✔ isWatchedFile은 제외 파일명을 걸러내고 .md만 허용한다 (0.7721ms)
✔ listMarkdownFiles는 재귀적으로 .md를 찾고 _templates 디렉토리는 건너뛴다 (11.8002ms)
✔ scanOnce는 매칭된 파일을 core.ingest에 벌크로 1회 전송하고 결과를 집계한다 (6.7113ms)
✔ scanOnce는 매칭된 파일이 없으면 core.ingest를 호출하지 않는다 (0.9484ms)
ℹ tests 63
ℹ suites 0
ℹ pass 63
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 168.7227
```

### `tools/eval_deep.mjs` 문법 검사

```
$ node --check eval_deep.mjs
(출력 없음, 종료 코드 0)
```

### 편차 / 설계 결정 기록

- **반박(rebuttal) 라운드는 동시성 풀 미적용**: 팀리드 지시문은 "클러스터 에이전트 실행"을 명시적으로 지목했다. `deep.ts`의 반박 라운드(모순 발견 시 재질의하는 부분)는 별도의 `Promise.all` 호출부로 남아있고, 이번 라운드에서 `mapWithConcurrencyLimit`으로 전환하지 않았다. 이유: (1) 지시문 표현이 "클러스터 에이전트" 단계로 한정되어 있고 반박 단계는 별개 코드 경로, (2) 반박 라운드는 모순이 발견된 클러스터에 한해서만 실행되어 동시 호출 개수가 이미 4(K 예산) 이하로 자연스레 제한되며, 3차 실측 증상(qd02, 3~4개 동시 spawn)의 재현 조건과 정확히 일치하는 병목은 클러스터 에이전트 스테이지였다. 반박 라운드까지 풀링하는 것은 스코프 확장으로 판단해 보류했다 — 필요 시 후속 라운드에서 동일 헬퍼(`mapWithConcurrencyLimit`)를 재사용해 확장 가능.
- **`mapWithConcurrencyLimit` 외부 의존성 없이 구현**: CONTRACT.md M1의 "런타임 의존성 0" 제약(`node:http`·`child_process`·global `fetch`만 허용)에 따라 `p-limit` 등 패키지를 쓰지 않고, 공유 커서 변수를 N개 워커가 소비하는 최소 구현으로 대체했다. 결과 배열은 원본 인덱스에 직접 기록하므로 완료 순서가 뒤섞여도 매핑 순서는 항상 보존된다.
- **`eval_deep.mjs`의 하네스 타임아웃 에러 메시지·비-2xx 처리 로직은 무수정**: `fetch`→`node:http` 전환은 전송 계층만 교체했고, 기존 "하네스 타임아웃(...)" 메시지 포맷과 비-2xx 응답 시 본문을 포함해 에러를 던지는 동작은 그대로 재현했다 — 팀리드 지시문이 두 동작 모두 "유지" 요구.

### 블로커

없음. 지시된 3개 파일 수정(`llm.ts`/`deep.ts`/`eval_deep.mjs`) + 관련 테스트(`llm.test.ts`/`deep.test.ts`) 전부 완료·검증되었다(기존 62건 회귀 없음 + 신규 1건 통과 = 63건). 실 LLM 호출과 실 게이트 재실행(수정된 타임아웃·동시성 풀로 qd01~qd05 재측정)은 이번 태스크 스펙이 명시적으로 관리자/team-lead 담당으로 규정했으므로 수행하지 않았다.

## M4

M4 mind 확장. 스코프: `D:\cosmos\mind\src` + `cosmos.config.json`(lifecycle 절) + `mind/package.json`만 수정. `mind/web/`은 디자이너 레인 소유 산출물 디렉토리 — 절대 생성·수정하지 않고 읽기만 했다(정적 서빙 테스트가 실제 그 파일들을 대상으로 검증). `core/`·`contract/`·`tools/` 무수정.

### 구현 산출물

| 파일 | 역할 |
|---|---|
| `src/lifecycle.ts` | 클러스터 생명주기 데몬. `runLifecycle`: core `GET /lifecycle/proposals`의 탄생 후보를 bootstrap.ts와 동일한 방식으로 LLM 라벨링(slug/name/description) 후 `POST /clusters/birth`(라벨링 실패는 해당 후보만 격리하고 나머지는 진행), 병합 후보는 같은 쌍이 **연속 2회** 관측되어야 실제 `POST /clusters/merge` 호출(히스테리시스, 상태는 `data/lifecycle.state.json`에 저장, `--dry-run`은 상태 파일 미기록). `lifecycleStatus`: 상태 파일을 변경하지 않고 현재 스트릭만 읽어 보고. |
| `src/universe.ts` | `GET /universe` 페이로드 조립. 클러스터 centroid를 고전적 MDS(`classicalMds3D`)로 3D 좌표화(입력이 같으면 항상 같은 좌표 — 결정론), 문서는 `hashDirection`(doc_id 해시 기반 결정론적 단위 벡터) + fit 기반 오프셋으로 클러스터 중심 주변에 배치, `buildEdges`는 코사인 유사도 0.3 이상 쌍만 중복·역방향 없이 연결(`>=` 경계 포함), `recent_queries`는 `queries.jsonl` 마지막 20건만 CONTRACT 형식으로 변환(파일 없으면 빈 배열). |
| `src/server.ts` | `GET /universe` 라우트(`buildUniverse` 호출, 실패 시 500) 추가. 정적 서빙: `GET /`→`mind/web/index.html`, `GET /web/(.*)`→`mind/web/` 하위 파일(확장자별 Content-Type 매핑, 미배치 파일은 503, 그 외 오류는 500). 경로 탈출 방어: `handleWebAsset`에서 `decodeURIComponent`(실패 시 400) 후 `serveWebAsset`에서 `path.resolve(WEB_ROOT, relPath)` 정규화 → `WEB_ROOT` 접두 포함 여부로 403 판정(윈도우 `path.sep` 처리 포함이므로 슬래시/백슬래시 탈출 모두 한 검사로 차단). 캐치올 라우트를 두지 않아 미정의 경로는 항상 404. |
| `src/server.test.ts` | **신규.** `/universe`(mock `CoreClient`로 200+필드 형태 검증), `/`와 `/web/<file>`(실제 `mind/web/` 파일을 확장자별 Content-Type으로 그대로 서빙하는지 바이트 비교), `/web/<미배치 파일>` 503, 경로 탈출 방어 3종(`..%5Cpackage.json` 단일 단계, `..%5C..%5Csrc%5Cserver.ts` 다단계, `..%2Fpackage.json` 인코딩 슬래시 — 모두 `mind/web/` 밖에 실존하는 파일을 목표로 삼아 "우연한 404"가 아닌 "존재하지만 차단됨"을 증명) 403, 리터럴 `../`는 URL 파서가 파싱 단계에서 이미 정규화해 `/web/*` 방어 코드 자체에 도달하지 않고 404가 됨을 별도로 확인, 미정의 경로 404(캐치올 위장 아님) 확인. 총 9건. |
| `src/cli.ts` | `lifecycle run [--dry-run]\|status`, `universe` 서브커맨드 추가. `lifecycle run`/`status`는 `runLifecycle`/`lifecycleStatus` 내부의 콘솔 요약 로그만 사용(`bootstrap`과 동일한 무-이중출력 관례), `universe`는 `console.log(JSON.stringify(...))`로 명시 덤프(`ask`/`collect`/`scan`과 동일한 관례). |
| `src/config.ts` | 확인만 — `LifecycleConfig`(`{birth_min, birth_cohesion, merge_sim}`)와 `CosmosConfig` 편입, `validateConfig()` 검증이 이전 세션에 이미 완료되어 있어 이번 세션에서는 변경 없음. |
| `D:\cosmos\cosmos.config.json` | 확인만 — `"lifecycle": {"birth_min": 12, "birth_cohesion": 0.55, "merge_sim": 0.85}` 절이 이전 세션에 이미 반영되어 있어 이번 세션에서는 변경 없음. |
| `mind/package.json` | 변경 없음 — 신규 런타임 의존성 0건(새 import는 모두 기존 로컬 모듈 `./lifecycle.js`/`./universe.js`). |

### 타입체크 & 빌드

```
$ npx tsc --noEmit
(출력 없음)
TSC_EXIT=0

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
BUILD_EXIT=0
```

### 단위 테스트 (`node --test "dist/**/*.test.js"`, Node v24.16.0)

전체 94건 전부 통과(0건 실패). `lifecycle.ts`(8건)·`universe.ts`(14건)는 기존 세션에서 이미 통과 확인되었고, 이번 세션에서는 `server.test.ts` 신규 9건 추가 후 및 `cli.ts` 서브커맨드 추가 후 두 차례 전체 재실행으로 회귀 0건을 재확인했다. 아래는 이번 세션 최종 확인용 재실행 전문(全文) 인용:

```
✔ parseArxivAtom은 entry 블록에서 id/title/authors/summary/published를 추출한다 (1.7671ms)
✔ parseFeed는 RSS item 블록을 파싱하고 CDATA+HTML 태그를 스트립한다 (0.7012ms)
✔ parseFeed는 RSS item이 없으면 Atom entry로 폴백한다 (0.1971ms)
✔ scoreText는 제목 2배·본문 1배 가중치로 매칭 키워드를 집계한다 (0.1376ms)
✔ selectTopCandidates는 점수 내림차순 정렬 후 상위 N개만 반환한다 (0.0953ms)
✔ cutUnseen은 lastSeenId 이전 항목만 남긴다(신규순 정렬 가정) (0.1727ms)
✔ advanceCursor는 새 커서로 상태를 갱신하되 원본은 불변으로 둔다 (0.0933ms)
✔ stripHtmlTags는 script/style을 제거하고 태그를 벗긴다 (0.0643ms)
✔ truncate는 max 길이를 넘으면 자른다 (0.0913ms)
✔ candidateId는 origin의 sha256 앞 12자를 반환하고 결정론적이다 (0.5178ms)
✔ extractTag는 속성이 있는 태그도 대소문자 무시하고 추출한다 (0.0789ms)
✔ decodeXmlEntities는 이름 엔티티와 숫자 엔티티를 모두 디코딩한다 (0.0886ms)
✔ (a) 플래너 응답에서 누락된 active 클러스터는 자동으로 skipped 처리된다 (0.8903ms)
✔ (b) 참여 클러스터가 예산(K=4)을 초과하면 라우팅 점수 상위 4개만 남긴다 (0.1751ms)
✔ (c) cites가 없거나 유효하지 않은 claim은 드랍된다 (0.1376ms)
✔ (d) 모순이 없으면 종합 콜은 1회만 실행된다 (17.8721ms)
✔ (e) 모순 발견 시 반박 1회 + 종합 2회가 실행된다 (131.3036ms)
✔ (f) 전 브리프 claims 합계가 0이면 종합 콜 없이 차단된다 (108.0644ms)
✔ (g) 전역 재번호와 trace 완전성을 갖춘 봉투를 조립한다 (120.8177ms)
✔ (h) 뮤텍스: 동시에 실행 중인 deep 요청이 있으면 두 번째 호출은 즉시 거부된다 (125.274ms)
✔ (i) 클러스터 에이전트 풀은 동시 2개를 초과하지 않고, 브리프-클러스터 매핑 순서를 보존한다 (222.7669ms)
✔ numberSources: 인용된 청크만 등장 순서대로 1..n 재번호를 매긴다 (0.817ms)
✔ numberSources: 인용되지 않은 청크는 sources에서 빠진다 (0.5667ms)
✔ renderAnswer: 문장 텍스트와 인용 번호를 이어붙인다 (0.1112ms)
✔ renderAnswer: 인용 없는 문장은 번호 없이 그대로 붙는다 (0.0636ms)
✔ assembleEnvelope: 정상 응답이면 재번호 매긴 sources와 trace를 포함한다 (0.1454ms)
✔ assembleEnvelope: insufficient면 BLOCK_MESSAGE를 answer로 사용한다 (0.0641ms)
✔ assembleEnvelope: insufficientAnswer가 주어지면 BLOCK_MESSAGE 대신 사용한다 (0.0679ms)
✔ 트리거 (c): 검색 결과가 없으면(null) LLM 호출을 생략한다 (0.4958ms)
✔ 트리거 (c): rerank_score가 음수면 LLM 호출을 생략한다 (0.068ms)
✔ 트리거 (c): rerank_score가 정확히 0.0이면 호출을 생략하지 않는다 (경계값) (0.0793ms)
✔ 트리거 (c): rerank_score가 양수면 호출을 생략하지 않는다 (0.1152ms)
✔ 트리거 (a): LLM이 insufficient=true를 선언하면 인용이 있어도 insufficient (0.1056ms)
✔ 트리거 (b): 문장이 하나도 없으면 insufficient (0.0576ms)
✔ 트리거 (b): 모든 문장의 cites가 비어있으면 insufficient (0.0623ms)
✔ 정상 사례: 인용이 하나라도 있으면 insufficient가 아니다 (0.0528ms)
✔ BLOCK_MESSAGE는 비어있지 않은 한국어 문자열이다 (0.1124ms)
✔ pending 생성 시점에는 core.ingest가 0회 호출된다 (10.8415ms)
✔ approveOne은 core.ingest를 정확히 1회 호출하고 approved/로 이동시키며 cluster_slug/fit을 기록한다 (6.4291ms)
✔ rejectOne은 core.ingest를 호출하지 않고 rejected/로 이동시킨다 (93.5466ms)
✔ approveMany은 존재하지 않는 id를 격리하고 유효한 id만 ingest를 호출한다 (285.7495ms)
✔ approveOne은 ingest가 실패하면 pending 파일을 그대로 남겨둔다(부분 실패 격리) (142.2478ms)
✔ renderPendingTable은 빈 배열에 안내 문구를 반환한다 (0.1638ms)
✔ 순수 JSON 문자열을 파싱한다 (1.1073ms)
✔ json 태그 코드펜스 안의 JSON을 추출한다 (0.2241ms)
✔ 태그 없는 코드펜스 안의 JSON을 추출한다 (0.1416ms)
✔ 전후 잡담 텍스트가 섞여 있어도 JSON을 추출한다 (0.709ms)
✔ 중첩된 중괄호를 올바르게 처리한다 (0.1351ms)
✔ JSON 객체가 없으면 에러를 던진다 (0.1705ms)
✔ 중괄호가 닫히지 않으면 에러를 던진다 (0.0767ms)
✔ 병합 후보를 1회만 관측하면 병합을 트리거하지 않는다 (112.5648ms)
✔ 같은 병합 후보 쌍을 연속 2회 관측하면 병합을 트리거하고 스트릭을 초기화한다 (234.1964ms)
✔ 병합 후보 쌍이 관측에서 빠지면 스트릭이 끊기고, 재관측 시 처음부터 다시 센다 (247.0672ms)
✔ --dry-run은 병합을 트리거할 스트릭이어도 API를 호출하지 않고 상태 파일도 갱신하지 않는다 (108.6092ms)
✔ 탄생 후보 하나의 LLM 라벨링이 실패해도 다른 후보는 정상적으로 탄생 처리된다 (75.5139ms)
✔ --dry-run에서 탄생 후보는 라벨링만 하고 탄생 API를 호출하지 않는다 (17.5587ms)
✔ 같은 실행 내 탄생 후보 slug가 충돌하면 dedupSlug로 접미사를 붙인다 (64.238ms)
✔ lifecycleStatus는 상태 파일을 변경하지 않고 현재 스트릭만 읽어 보고한다 (6.0244ms)
✔ 모델별 기본 타임아웃: sonnet=360000ms, opus=420000ms (0.5261ms)
✔ env 오버라이드가 있으면 그 값을 사용한다 (0.13ms)
✔ env 오버라이드 파싱 실패 시 모델별 기본값으로 폴백한다 (0.1121ms)
✔ 빈 입력이면 빈 배열을 반환한다 (0.8591ms)
✔ computeRouteScore는 bm25_hits를 10으로 캡하고 0.02 가중치를 곱한다 (0.1159ms)
✔ 상위 K=3은 consulted, 그 밖 순위는 top K 밖 사유로 skipped (0.2789ms)
✔ 상위 K 이내라도 score < 0.6*top이면 skipped로 강등한다 (0.9151ms)
✔ 정확히 0.6*top 경계값은 consulted로 처리한다 (>=) (0.1536ms)
✔ consultedClusterIds는 consulted 항목의 cluster_id만 추출한다 (0.1344ms)
✔ GET /universe는 core 데이터로 조립한 우주 페이로드를 200으로 반환한다 (83.8616ms)
✔ GET /는 mind/web/index.html을 그대로 서빙한다 (8.4106ms)
✔ GET /web/<file>은 실제 확장자별 Content-Type으로 파일을 그대로 서빙한다 (37.4822ms)
✔ GET /web/<존재하지 않는 파일>은 503 웹 자산 미배치로 응답한다 (4.4018ms)
✔ GET /web/..%5C<실제 존재 파일>은 윈도우 역슬래시 인코딩 경로 탈출을 403으로 차단한다 (4.1323ms)
✔ GET /web/..%5C..%5Csrc%5Cserver.ts 같은 깊은 역슬래시 체인도 403으로 차단한다 (3.2584ms)
✔ GET /web/..%2Fpackage.json (인코딩된 슬래시)도 403으로 차단한다 (3.7402ms)
✔ GET /web/../package.json (리터럴 상대경로)는 URL 파서가 정규화해 /web/* 라우트 자체에 도달하지 않고 404가 된다 (4.296ms)
✔ 정의되지 않은 경로는 여전히 404를 반환한다(캐치올로 위장되지 않음) (3.4991ms)
✔ decodeCentroid는 base64 f32le를 왕복 디코드한다 (0.7481ms)
✔ cosineSimilarity는 동일 벡터에서 1을, 직교 벡터에서 0을 반환한다 (0.1235ms)
✔ classicalMds3D는 동일 입력에 대해 항상 동일 좌표를 낸다(결정론) (2.2194ms)
✔ classicalMds3D는 코사인 거리가 가까운 쌍을 먼 쌍보다 3D에서 더 가깝게 배치하는 경향을 보인다 (0.4389ms)
✔ classicalMds3D는 n=0/1일 때 안전하게 처리한다 (0.0989ms)
✔ hashDirection은 동일 doc_id에 대해 항상 동일한 단위 벡터를 반환한다 (0.5536ms)
✔ docPosition은 동일 입력에 대해 결정론적이다 (0.1383ms)
✔ docPosition은 fit이 높을수록 클러스터 중심에 더 가깝다(오프셋이 작다) (0.1183ms)
✔ docPosition은 fit이 null이면 0.55로 취급한다 (0.1362ms)
✔ buildEdges는 코사인 유사도 0.3 이상인 쌍만, 중복/역방향 없이 만든다 (0.2245ms)
✔ buildEdges는 0.3 바로 위 유사도는 포함하고 바로 아래 유사도는 제외한다(>= 경계) (0.1413ms)
✔ buildUniverse는 클러스터/문서 좌표를 계산하고 recent_queries를 CONTRACT 형식으로 변환한다 (115.9616ms)
✔ buildUniverse는 queries.jsonl이 없으면 recent_queries를 빈 배열로 반환한다 (64.3052ms)
✔ buildUniverse는 queries.jsonl 마지막 20건만 recent_queries로 반환한다 (106.7757ms)
✔ isWatchedFile은 제외 파일명을 걸러내고 .md만 허용한다 (0.52ms)
✔ listMarkdownFiles는 재귀적으로 .md를 찾고 _templates 디렉토리는 건너뛴다 (12.6867ms)
✔ scanOnce는 매칭된 파일을 core.ingest에 벌크로 1회 전송하고 결과를 집계한다 (145.7201ms)
✔ scanOnce는 매칭된 파일이 없으면 core.ingest를 호출하지 않는다 (58.2502ms)
ℹ tests 94
ℹ suites 0
ℹ pass 94
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1657.7759
```

### 편차 / 설계 결정 기록

- **경로 탈출 403 vs 미배치 자산 503 구분**: 두 경우 모두 "파일을 못 준다"는 점은 같지만 원인이 다르다 — 전자는 요청 자체가 허용 범위를 벗어난 보안 위반(항상 403 고정), 후자는 디자이너 레인 산출물이 아직 해당 파일을 만들지 않았을 뿐인 운영상 정상 상태(503로 "일시적/배치 대기"임을 구분). 두 응답을 하나의 코드로 합치지 않고 `serveWebAsset` 안에서 컨테인먼트 검사(403)와 `readFile` 예외 코드 분기(ENOENT/EISDIR→503, 그 외→500)를 명확히 분리했다.
- **캐치올/SPA 폴백 라우트를 의도적으로 두지 않음**: 위키 교훈(`spa-fallback-masks-path-traversal-probes`)에 따라, 정의되지 않은 모든 경로를 200으로 감싸는 폴백을 두면 경로 탈출 방어가 실제로 작동하는지 응답 상태만으로는 판별 불가능해진다. `server.ts`는 미매치 경로를 항상 순수 404로 떨어뜨리고, `server.test.ts`에 이를 직접 검증하는 전용 테스트("정의되지 않은 경로는 여전히 404를 반환한다(캐치올로 위장되지 않음)")를 별도로 두었다.
- **URL 정규화 실측에 기반한 탈출 테스트 설계**: WHATWG `URL` 생성자가 리터럴 `../`와 퍼센트인코딩-DOT(`%2e%2e`)는 파싱 단계에서 이미 접어(pathname 정규화) `/web/*` 방어 코드 자체에 도달하지 못하게 만든다는 점을 실측으로 확인했다(해당 케이스는 404로 별도 테스트해 "방어 로직이 아니라 파서가 처리했다"는 점을 문서화). 반면 퍼센트인코딩-슬래시(`%2F`)와 백슬래시(`%5C`)는 정규화되지 않고 그대로 `url.pathname`을 통과해 라우트 매칭 이후 `decodeURIComponent`로만 디코드되므로, 이 두 인코딩이 실제 방어 코드(403)를 검증하는 핵심 테스트 대상이 되었다. 윈도우 전용 공격 표면인 `..%5C`(역슬래시)를 단일 단계·다단계 체인 두 가지로 모두 검증했다.
- **`lifecycle`/`universe` CLI 서브커맨드의 출력 관례 분리**: `lifecycle run`/`status`는 `runLifecycle`/`lifecycleStatus` 내부에 이미 구현된 콘솔 요약(`printRunSummary`/`printStatus`)만 사용하고 별도로 JSON을 다시 찍지 않는다(`bootstrap` 서브커맨드와 동일한 무-이중출력 관례). `universe`는 반대로 `console.log(JSON.stringify(payload, null, 2))`로 명시 덤프한다(`ask`/`collect`/`scan`과 동일한 관례, 태스크 스펙의 "JSON-to-stdout" 표현과도 일치). 두 관례를 하나로 통일하지 않고 기존 커맨드들의 선례를 그대로 따랐다.
- **`config.ts`/`cosmos.config.json`은 무변경**: `LifecycleConfig` 타입과 실제 `"lifecycle"` JSON 절이 이전 세션에 이미 정확히 구현되어 있음을 이번 세션에 다시 읽어 확인했다 — 중복 구현을 피하기 위해 손대지 않았다.
- **`mind/web/`은 읽기 전용으로만 취급**: `server.test.ts`는 디자이너 레인이 채운 실제 `mind/web/` 파일(`index.html`/`style.css`/`app.js`/`dev-fixture.json`)을 대상으로 바이트 단위 비교까지 수행하지만, 그 디렉토리에 파일을 쓰거나 만드는 코드는 어디에도 없다.

### 블로커

없음. 지시된 4개 산출물(`lifecycle.ts`/`universe.ts`/`server.ts`+`server.test.ts`/`cli.ts` 서브커맨드) 전부 완료·검증되었다(전체 94건 테스트 통과, 회귀 0건). 실 core 서버 대상 E2E 통합 테스트와 M4 게이트 재검증(#34)은 이번 태스크 스펙이 명시적으로 관리자/team-lead 담당으로 규정했으므로 수행하지 않았다.

## M5

M5 mind 확장: 토큰 인증 + `/ingest` 프록시 + 원격 스캔 + 워처 자동 스킵 + cron 타이머 + 웹 토큰 프롬프트. 스코프: `D:\cosmos\mind\src`(신규 테스트 파일 포함) + `mind/web`(토큰 프롬프트 최소 수정) + `cosmos.config.json`(`cron` 절)만 수정. `core/`·`contract/`·`deploy/`·`mcp/` 무수정.

### 구현 산출물

| 파일 | 역할 |
|---|---|
| `src/core-client.ts` | `CosmosCoreClient` 생성자가 `COSMOS_CORE_URL` env를 우선 사용하고, 없으면 기존 기본값으로 폴백(원격 core 배포 대응). |
| `src/server.ts` | `isTokenValid(req)`: `COSMOS_TOKEN` env가 비어 있으면 항상 `true`(로컬 개발 모드 전면 공개), 설정돼 있으면 `Authorization: Bearer <token>` 헤더가 정확히 일치해야 `true`. `requireAuth`가 실패 시 401 + `{message: "인증 토큰이 필요합니다"}`로 조기 반환. `POST /ask`, `GET /inbox`, `POST /inbox/:id/(approve\|reject)`, `POST /ingest`에 게이트를 걸었고, `GET /`·`GET /web/*`·`GET /health`·`GET /universe`는 항상 공개로 남겨 정적 자산·헬스체크·시각화가 인증 없이도 항상 뜨도록 했다. |
| `src/server.ts` (신규 라우트) | `POST /ingest`: 요청 바디 `{docs:[...]}`를 그대로 `core.ingest()`로 전달하고 응답을 그대로 반환(가공 없는 순수 프록시), 실패 시 500 + `/ingest 처리 실패: <메시지>`. |
| `src/watcher.ts` | `scanOnce`가 `COSMOS_MIND_URL` env가 설정돼 있으면 `core.ingest()`를 직접 부르지 않고 `${COSMOS_MIND_URL}/ingest`로 `fetchImpl`(테스트 주입 가능, 기본은 전역 `fetch`) POST(`Content-Type: application/json` + `COSMOS_TOKEN`이 있으면 `Authorization: Bearer <token>` 헤더 첨부)한다. 미설정 시 기존처럼 `core.ingest()` 직접 호출로 폴백(원격/로컬 두 배포 형태 모두 동일한 워처 코드로 대응). |
| `src/cli.ts` | `anyDirExists(dirs)` 신규 export: 대상 디렉터리 중 하나라도 디스크에 실재하면 `true`. `serve` 커맨드가 `main()` 실행 전에 이를 호출해, 워처 대상 디렉터리가 전부 없으면 워처 타이머 자체를 띄우지 않고 `"워처 비활성: 대상 디렉터리 없음"`만 로그(하나라도 있으면 기존처럼 시작 로그 후 정상 기동). 같은 `serve` 분기에서 `startCronJobs(config, core, llm)`도 함께 기동. 부수 인프라 수정: `anyDirExists`를 `cli.test.ts`가 import만 해도 `main().catch(...)`이 모듈 로드 시점에 함께 실행되어 `process.exitCode`가 오염되는 문제가 있어, `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])`로 "이 모듈이 직접 실행된 진입점인가"를 판별하는 가드를 추가하고 그 조건 안에서만 `main()`을 구동하도록 바꿨다(CommonJS `require.main === module`의 ESM 대응). |
| `src/cron.ts` | **신규.** `CronJob` 클래스: `{name, intervalHours, dataDir, run}`을 받아 `busy` 플래그로 오버랩을 막는 `tick()`을 제공(`intervalHours<=0`이면 비활성)하고, 매 실행 시작/완료를 콘솔과 `data/cron.log`에 함께 기록한다. `startCronJobs(config, core, llm)`: `config.cron`의 `collect_interval_hours`/`lifecycle_interval_hours`(0=해당 작업 off)로 `runCollect`/`runLifecycle`을 감싼 두 개의 `CronJob`을 만들어 `setInterval`로 구동한다. |
| `src/config.ts` | `CronConfig {collect_interval_hours, lifecycle_interval_hours}` 타입과 `CosmosConfig.cron?: CronConfig` 선택 필드 추가(`policy`와 동일하게 `validateConfig()` 필수 검증 대상에서 제외 — 없으면 cron 전체 비활성으로 취급). |
| `D:\cosmos\cosmos.config.json` | `"cron": {"collect_interval_hours": 24, "lifecycle_interval_hours": 24}` 절 추가. |
| `mind/web/ask.js` | `fetchAsk`가 `POST /ask`에서 401을 받으면 `prompt()`로 토큰을 물어 `localStorage`에 저장 후 `Authorization` 헤더를 붙여 1회 재시도. 이후 요청은 저장된 토큰을 자동으로 재사용. |
| `src/server.test.ts` | **신규 3건 추가**(scenario a/b/c). (a) `COSMOS_TOKEN` 미설정 시 `POST /ask`·`POST /ingest` 모두 인증 없이 통과. (b) `COSMOS_TOKEN` 설정 시 `POST /ask`는 헤더 누락·오답에서 401, 정답 `Bearer` 헤더는 200(하나의 테스트 안에서 401→401→200 순서로 검증). (c) `POST /ingest`가 토큰 인증 통과 시 바디를 `core.ingest`에 그대로 전달하고 응답을 그대로 반환하는지 mock core로 검증. |
| `src/watcher.test.ts` | **신규 1건 추가**(scenario d). `COSMOS_MIND_URL` 설정 시 `scanOnce`가 `core.ingest`를 호출하지 않고 대신 주입된 `fetchImpl`로 `${COSMOS_MIND_URL}/ingest`에 POST(메서드/헤더/`Authorization`/바디 형태까지 검증)하는지 확인. |
| `src/cli.test.ts` | **신규 파일**(scenario e, 3건). `anyDirExists`가 (1) 전부 없으면 `false`, (2) 하나라도 있으면 `true`, (3) 빈 배열이면 `false`를 반환하는지 검증. |
| `src/cron.test.ts` | **신규 파일**(scenario f, 1건). `CronJob.tick()`을 실제 타이머 없이 두 번 연달아 호출해, 첫 실행이 진행 중일 때 두 번째 호출은 `busy` 가드로 즉시 무시되고(`runCount`가 늘지 않고 동시 실행 최대치가 1을 넘지 않음) 첫 실행이 끝난 뒤에는 다시 정상 실행됨을 검증. `data/cron.log`에 완료 기록이 2회만 남는지도 함께 확인. |

### 타입체크 & 빌드

```
$ npx tsc --noEmit
(출력 없음)
TSC_EXIT=0

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
BUILD_EXIT=0
```

### 단위 테스트 (`node --test "dist/**/*.test.js"`, Node v24.16.0)

전체 102건 전부 통과(0건 실패, 회귀 0건). 기존 94건(M1~M4)은 그대로 유지되고, 이번 세션에 scenario (a)~(f) 총 8건이 신규 추가되었다: (a)/(b)/(c)는 `server.test.ts`(토큰 인증 미설정 통과·설정 시 401/200·`/ingest` 프록시), (d)는 `watcher.test.ts`(`COSMOS_MIND_URL` 원격 스캔 분기), (e)는 신규 `cli.test.ts` 3건(`anyDirExists` 워처 자동 스킵 판단), (f)는 신규 `cron.test.ts` 1건(`CronJob.tick()` 오버랩 가드). 아래는 최종 확인용 재실행 전문(全文) 인용:

```
✔ anyDirExists는 대상 디렉터리가 모두 존재하지 않으면 false를 반환한다 (2.8893ms)
✔ anyDirExists는 대상 디렉터리 중 하나라도 존재하면 true를 반환한다 (1.5779ms)
✔ anyDirExists는 빈 배열을 넘기면 false를 반환한다 (0.1522ms)
✔ parseArxivAtom은 entry 블록에서 id/title/authors/summary/published를 추출한다 (2.0901ms)
✔ parseFeed는 RSS item 블록을 파싱하고 CDATA+HTML 태그를 스트립한다 (0.7511ms)
✔ parseFeed는 RSS item이 없으면 Atom entry로 폴백한다 (0.2041ms)
✔ scoreText는 제목 2배·본문 1배 가중치로 매칭 키워드를 집계한다 (0.128ms)
✔ selectTopCandidates는 점수 내림차순 정렬 후 상위 N개만 반환한다 (0.8471ms)
✔ cutUnseen은 lastSeenId 이전 항목만 남긴다(신규순 정렬 가정) (0.1909ms)
✔ advanceCursor는 새 커서로 상태를 갱신하되 원본은 불변으로 둔다 (0.2472ms)
✔ stripHtmlTags는 script/style을 제거하고 태그를 벗긴다 (0.1037ms)
✔ truncate는 max 길이를 넘으면 자른다 (0.1463ms)
✔ candidateId는 origin의 sha256 앞 12자를 반환하고 결정론적이다 (0.5158ms)
✔ extractTag는 속성이 있는 태그도 대소문자 무시하고 추출한다 (0.1069ms)
✔ decodeXmlEntities는 이름 엔티티와 숫자 엔티티를 모두 디코딩한다 (0.1136ms)
✔ CronJob.tick()은 실행 중일 때 재호출을 무시하고, 완료 후에는 다시 실행된다 (7.6768ms)
✔ (a) 플래너 응답에서 누락된 active 클러스터는 자동으로 skipped 처리된다 (1.6038ms)
✔ (b) 참여 클러스터가 예산(K=4)을 초과하면 라우팅 점수 상위 4개만 남긴다 (0.3182ms)
✔ (c) cites가 없거나 유효하지 않은 claim은 드랍된다 (0.2037ms)
✔ (d) 모순이 없으면 종합 콜은 1회만 실행된다 (9.8148ms)
✔ (e) 모순 발견 시 반박 1회 + 종합 2회가 실행된다 (3.248ms)
✔ (f) 전 브리프 claims 합계가 0이면 종합 콜 없이 차단된다 (4.2391ms)
✔ (g) 전역 재번호와 trace 완전성을 갖춘 봉투를 조립한다 (2.9615ms)
✔ (h) 뮤텍스: 동시에 실행 중인 deep 요청이 있으면 두 번째 호출은 즉시 거부된다 (4.376ms)
✔ (i) 클러스터 에이전트 풀은 동시 2개를 초과하지 않고, 브리프-클러스터 매핑 순서를 보존한다 (53.2943ms)
✔ numberSources: 인용된 청크만 등장 순서대로 1..n 재번호를 매긴다 (1.1904ms)
✔ numberSources: 인용되지 않은 청크는 sources에서 빠진다 (0.6431ms)
✔ renderAnswer: 문장 텍스트와 인용 번호를 이어붙인다 (0.1163ms)
✔ renderAnswer: 인용 없는 문장은 번호 없이 그대로 붙는다 (0.0641ms)
✔ assembleEnvelope: 정상 응답이면 재번호 매긴 sources와 trace를 포함한다 (0.156ms)
✔ assembleEnvelope: insufficient면 BLOCK_MESSAGE를 answer로 사용한다 (0.1926ms)
✔ assembleEnvelope: insufficientAnswer가 주어지면 BLOCK_MESSAGE 대신 사용한다 (0.1385ms)
✔ 트리거 (c): 검색 결과가 없으면(null) LLM 호출을 생략한다 (0.7644ms)
✔ 트리거 (c): rerank_score가 음수면 LLM 호출을 생략한다 (0.1167ms)
✔ 트리거 (c): rerank_score가 정확히 0.0이면 호출을 생략하지 않는다 (경계값) (0.0846ms)
✔ 트리거 (c): rerank_score가 양수면 호출을 생략하지 않는다 (0.1364ms)
✔ 트리거 (a): LLM이 insufficient=true를 선언하면 인용이 있어도 insufficient (0.1098ms)
✔ 트리거 (b): 문장이 하나도 없으면 insufficient (0.1291ms)
✔ 트리거 (b): 모든 문장의 cites가 비어있으면 insufficient (0.1127ms)
✔ 정상 사례: 인용이 하나라도 있으면 insufficient가 아니다 (0.0628ms)
✔ BLOCK_MESSAGE는 비어있지 않은 한국어 문자열이다 (0.1178ms)
✔ pending 생성 시점에는 core.ingest가 0회 호출된다 (8.2028ms)
✔ approveOne은 core.ingest를 정확히 1회 호출하고 approved/로 이동시키며 cluster_slug/fit을 기록한다 (7.7605ms)
✔ rejectOne은 core.ingest를 호출하지 않고 rejected/로 이동시킨다 (7.1571ms)
✔ approveMany은 존재하지 않는 id를 격리하고 유효한 id만 ingest를 호출한다 (5.8851ms)
✔ approveOne은 ingest가 실패하면 pending 파일을 그대로 남겨둔다(부분 실패 격리) (4.0391ms)
✔ renderPendingTable은 빈 배열에 안내 문구를 반환한다 (0.1892ms)
✔ 순수 JSON 문자열을 파싱한다 (1.2278ms)
✔ json 태그 코드펜스 안의 JSON을 추출한다 (0.2627ms)
✔ 태그 없는 코드펜스 안의 JSON을 추출한다 (0.1931ms)
✔ 전후 잡담 텍스트가 섞여 있어도 JSON을 추출한다 (0.8213ms)
✔ 중첩된 중괄호를 올바르게 처리한다 (0.1815ms)
✔ JSON 객체가 없으면 에러를 던진다 (0.2256ms)
✔ 중괄호가 닫히지 않으면 에러를 던진다 (0.1083ms)
✔ 병합 후보를 1회만 관측하면 병합을 트리거하지 않는다 (7.3456ms)
✔ 같은 병합 후보 쌍을 연속 2회 관측하면 병합을 트리거하고 스트릭을 초기화한다 (4.9396ms)
✔ 병합 후보 쌍이 관측에서 빠지면 스트릭이 끊기고, 재관측 시 처음부터 다시 센다 (5.7471ms)
✔ --dry-run은 병합을 트리거할 스트릭이어도 API를 호출하지 않고 상태 파일도 갱신하지 않는다 (3.0293ms)
✔ 탄생 후보 하나의 LLM 라벨링이 실패해도 다른 후보는 정상적으로 탄생 처리된다 (2.8849ms)
✔ --dry-run에서 탄생 후보는 라벨링만 하고 탄생 API를 호출하지 않는다 (1.3177ms)
✔ 같은 실행 내 탄생 후보 slug가 충돌하면 dedupSlug로 접미사를 붙인다 (2.324ms)
✔ lifecycleStatus는 상태 파일을 변경하지 않고 현재 스트릭만 읽어 보고한다 (3.5068ms)
✔ 모델별 기본 타임아웃: sonnet=360000ms, opus=420000ms (0.678ms)
✔ env 오버라이드가 있으면 그 값을 사용한다 (0.1412ms)
✔ env 오버라이드 파싱 실패 시 모델별 기본값으로 폴백한다 (0.0883ms)
✔ 빈 입력이면 빈 배열을 반환한다 (0.738ms)
✔ computeRouteScore는 bm25_hits를 10으로 캡하고 0.02 가중치를 곱한다 (0.1433ms)
✔ 상위 K=3은 consulted, 그 밖 순위는 top K 밖 사유로 skipped (0.2849ms)
✔ 상위 K 이내라도 score < 0.6*top이면 skipped로 강등한다 (0.728ms)
✔ 정확히 0.6*top 경계값은 consulted로 처리한다 (>=) (0.123ms)
✔ consultedClusterIds는 consulted 항목의 cluster_id만 추출한다 (0.1322ms)
✔ GET /universe는 core 데이터로 조립한 우주 페이로드를 200으로 반환한다 (32.7888ms)
✔ GET /는 mind/web/index.html을 그대로 서빙한다 (7.2652ms)
✔ GET /web/<file>은 실제 확장자별 Content-Type으로 파일을 그대로 서빙한다 (8.3786ms)
✔ GET /web/<존재하지 않는 파일>은 503 웹 자산 미배치로 응답한다 (3.3397ms)
✔ GET /web/..%5C<실제 존재 파일>은 윈도우 역슬래시 인코딩 경로 탈출을 403으로 차단한다 (3.1864ms)
✔ GET /web/..%5C..%5Csrc%5Cserver.ts 같은 깊은 역슬래시 체인도 403으로 차단한다 (3.2412ms)
✔ GET /web/..%2Fpackage.json (인코딩된 슬래시)도 403으로 차단한다 (3.1819ms)
✔ GET /web/../package.json (리터럴 상대경로)는 URL 파서가 정규화해 /web/* 라우트 자체에 도달하지 않고 404가 된다 (2.774ms)
✔ 정의되지 않은 경로는 여전히 404를 반환한다(캐치올로 위장되지 않음) (5.1873ms)
✔ COSMOS_TOKEN 미설정 시 POST /ask, POST /ingest 모두 인증 없이 통과한다 (8.5413ms)
✔ COSMOS_TOKEN 설정 시 POST /ask는 헤더 누락·오답 시 401, 정답 Bearer 헤더는 200을 반환한다 (6.0163ms)
✔ POST /ingest는 토큰 인증 통과 시 요청 본문을 core.ingest에 그대로 전달하고 응답을 그대로 반환한다 (4.4765ms)
✔ decodeCentroid는 base64 f32le를 왕복 디코드한다 (0.6398ms)
✔ cosineSimilarity는 동일 벡터에서 1을, 직교 벡터에서 0을 반환한다 (0.0955ms)
✔ classicalMds3D는 동일 입력에 대해 항상 동일 좌표를 낸다(결정론) (2.3558ms)
✔ classicalMds3D는 코사인 거리가 가까운 쌍을 먼 쌍보다 3D에서 더 가깝게 배치하는 경향을 보인다 (0.5317ms)
✔ classicalMds3D는 n=0/1일 때 안전하게 처리한다 (0.3944ms)
✔ hashDirection은 동일 doc_id에 대해 항상 동일한 단위 벡터를 반환한다 (0.5888ms)
✔ docPosition은 동일 입력에 대해 결정론적이다 (0.1938ms)
✔ docPosition은 fit이 높을수록 클러스터 중심에 더 가깝다(오프셋이 작다) (0.1615ms)
✔ docPosition은 fit이 null이면 0.55로 취급한다 (0.1953ms)
✔ buildEdges는 코사인 유사도 0.3 이상인 쌍만, 중복/역방향 없이 만든다 (0.2621ms)
✔ buildEdges는 0.3 바로 위 유사도는 포함하고 바로 아래 유사도는 제외한다(>= 경계) (0.1321ms)
✔ buildUniverse는 클러스터/문서 좌표를 계산하고 recent_queries를 CONTRACT 형식으로 변환한다 (7.89ms)
✔ buildUniverse는 queries.jsonl이 없으면 recent_queries를 빈 배열로 반환한다 (0.789ms)
✔ buildUniverse는 queries.jsonl 마지막 20건만 recent_queries로 반환한다 (2.3834ms)
✔ isWatchedFile은 제외 파일명을 걸러내고 .md만 허용한다 (0.4739ms)
✔ listMarkdownFiles는 재귀적으로 .md를 찾고 _templates 디렉토리는 건너뛴다 (10.3524ms)
✔ scanOnce는 매칭된 파일을 core.ingest에 벌크로 1회 전송하고 결과를 집계한다 (6.1674ms)
✔ scanOnce는 매칭된 파일이 없으면 core.ingest를 호출하지 않는다 (0.941ms)
✔ scanOnce는 COSMOS_MIND_URL 설정 시 core.ingest 대신 mind의 /ingest로 POST한다 (7.5015ms)
ℹ tests 102
ℹ suites 0
ℹ pass 102
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 275.1154
```

### 편차 / 설계 결정 기록

- **`cli.ts` 진입점 가드 추가(스펙 외 인프라 수정)**: 원래 태스크 항목에는 없었지만, `anyDirExists`를 테스트하려면 `cli.test.ts`가 `cli.ts`를 `import`해야 하는데, 기존 코드는 모듈 최상단에서 무조건 `main().catch(...)`을 실행해 `import`만으로도 CLI 디스패치(알 수 없는 명령 처리 등)가 함께 발동해 `process.exitCode`를 오염시킬 수 있었다. `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])`로 "직접 실행된 진입점"인지 판별하는 가드를 추가해, `node dist/cli.js ...`로 직접 실행될 때만 `main()`이 구동되고 테스트 등에서 `import`할 때는 함수 정의만 로드되도록 했다. `serve`/`ask`/`scan` 등 기존 CLI 동작에는 영향 없음(직접 실행 경로는 그대로 `main()`이 구동됨).
- **scenario (e)를 1건이 아닌 3건으로 분리**: `anyDirExists`의 세 가지 경계(전부 없음/하나라도 있음/빈 배열)를 각각 독립된 `test()`로 나눠, 실패 시 어느 경계 조건이 깨졌는지 테스트 이름만으로 바로 식별되게 했다(다른 M3/M4 테스트 파일들도 동일하게 조건별 개별 `test()` 관례를 따름).
- **scenario (b)를 하나의 테스트 안에서 401→401→200 순서로 검증**: "헤더 누락 시 401", "오답 토큰 시 401", "정답 토큰 시 200"을 별도 테스트로 쪼개지 않고 한 흐름으로 묶은 이유는, `isTokenValid`가 `process.env.COSMOS_TOKEN`을 매 호출마다 새로 읽는 상태 비저장(stateless) 함수라 같은 서버 인스턴스에 대해 헤더만 바꿔가며 연속 요청해도 순서 의존성이나 잔여 상태 문제가 없기 때문이다. 세 시나리오를 나눠 세 번 서버를 띄우는 대신 한 테스트로 묶어 셋업 비용을 줄였다.
- **cron 오버랩 가드 검증에 실제 타이머를 쓰지 않음**: `CronJob.tick()`을 `await` 없이 두 번 연달아 호출하는 방식으로 오버랩을 동기적으로 재현했다(`watcher.ts`의 기존 `busy` 플래그 패턴과 동일). `setInterval` 기반 실통합 테스트 대신 이 방식을 택해 테스트가 밀리초 단위로 끝나고 타이밍에 좌우되지 않는다.
- **`COSMOS_MIND_URL`/`COSMOS_TOKEN` 헤더 첨부는 두 값 모두 있을 때만**: `scanOnce`가 원격 프록시로 보낼 때 `COSMOS_TOKEN`이 설정돼 있지 않으면 `Authorization` 헤더 자체를 생략한다(로컬 무인증 mind 배포와의 호환). 토큰이 있을 때만 `Bearer` 헤더를 붙이는 이 분기를 `watcher.test.ts` scenario (d)에서 토큰을 설정한 케이스로 명시 검증했다.
- **`GET /`, `GET /web/*`, `GET /health`, `GET /universe`는 토큰 게이트 밖에 고정**: 정적 자산과 헬스체크, 시각화 페이로드는 토큰 인증이 걸려 있어도 항상 공개로 남겨야 웹 UI 자체가 뜨고(토큰 프롬프트 UI를 보여줄 화면조차 못 뜨는 상황 방지) 배포 모니터링이 끊기지 않는다. `requireAuth` 호출을 `POST /ask`·`/inbox` 계열·`POST /ingest`에만 배치했다.
- **`config.ts`의 `cron` 필드를 선택(optional)으로 둠**: `policy`와 동일한 선례를 따라 `validateConfig()`의 필수 검증 대상에서 제외했다 — `cron` 절이 없는 `cosmos.config.json`으로도 `serve`가 정상 기동하고(`startCronJobs`가 두 간격 모두 0/미정으로 취급해 타이머를 걸지 않음) 하위 호환을 깨지 않는다.

### 블로커

없음. 지시된 7개 구현 항목(#6~#11에 대응하는 core-client env override, 서버 토큰 인증, `/ingest` 프록시, 원격 스캔 분기, 워처 자동 스킵, cron 타이머, 웹 토큰 프롬프트)과 6개 신규 테스트 시나리오(a)~(f) 전부 완료·검증되었다(전체 102건 테스트 통과, 회귀 0건). 실 core 서버 대상 E2E 통합 테스트, 배포 자산(`deploy/`), MCP 브리지(`mcp/`), 계약 확장(`contract/`) 검증은 이번 태스크 스펙이 명시적으로 다른 레인(본체/M5 Docker·배포/M5 MCP 브리지) 담당으로 규정했으므로 이 세션에서 수행하지 않았다.

## M5 수정 라운드 1

MCP 브리지 레인(#4)이 계약 검토 중 `POST /search` 프록시 누락을 발견해 team-lead가 추가 지시한 8번째 구현 항목. `mind`가 이미 알고 있는 `CoreClient.search()`(기존 `/ask` 경로에서 내부적으로 사용 중)를 그대로 재사용해, 외부에서 직접 `POST /search`로 core 검색을 호출할 수 있는 프록시 라우트를 신설했다. MCP `cosmos_search` 도구가 core의 `{results:[...], stats}` 응답 shape을 그대로 기대하므로 변형 없이 그대로 전달·반환한다.

### 구현 산출물

| 파일 | 역할 |
| --- | --- |
| `src/server.ts` | `handleSearch` 신설(`/ingest` 프록시와 동일한 read-body → `deps.core.search()` 위임 → `sendJson` 패턴). `POST /search` 라우트를 `requireAuth` 게이트 밖에 배치(`GET /universe`와 동급 공개 읽기 전용 엔드포인트). `SearchRequest` 타입 import 추가. |
| `src/server.test.ts` | `MockCoreClient`에 `searchCalls: SearchRequest[]` 트래킹 추가(기존 `ingestCalls` 관례와 동일하게 `search(req)`가 호출을 기록하도록 확장). scenario (g) 신규 테스트 1건. |

### 타입체크 & 빌드

```
$ npx tsc -p tsconfig.json --noEmit
(출력 없음, exit 0)

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
(exit 0)
```

### 단위 테스트 (`node --test "dist/**/*.test.js"`)

기존 102건 전원 재확인 + scenario (g) 1건 신규 추가로 총 103건. 신규 테스트 통과 라인:

```
✔ POST /search는 COSMOS_TOKEN 설정 상태에서도 인증 없이 통과하고, 요청 본문을 core.search로 그대로 전달하며 응답을 그대로 반환한다 (2.9811ms)
```

요약 라인:

```
ℹ tests 103
ℹ suites 0
ℹ pass 103
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 678.0018
```

### 편차 / 설계 결정 기록

- **`/search`를 토큰 게이트 밖의 공개 엔드포인트로 배치**: team-lead 지시대로 읽기 전용이며 `/universe`와 동급으로 취급했다. `requireAuth` 호출을 넣지 않고, `COSMOS_TOKEN`이 설정돼 있어도 인증 없이 통과하는지를 scenario (g) 테스트에서 직접 검증했다(`process.env.COSMOS_TOKEN`을 설정한 상태로 시작해 `/search` 호출이 200으로 통과함을 확인).
- **응답을 변형 없이 그대로 프록시**: `deps.core.search(body)`의 반환값을 가공 없이 `sendJson(res, 200, response)`로 그대로 내보낸다. MCP `cosmos_search`가 core의 `{results, stats}` shape을 직접 파싱하므로 필드 재매핑이나 래핑을 추가하면 계약이 깨진다 — `/ingest` 프록시와 동일한 무변형 원칙을 따랐다.
- **`MockCoreClient.search()`를 `ingestCalls` 관례와 동일하게 확장**: 기존에는 `search()`가 인자를 무시하고 고정된 빈 결과만 반환했다(`/ask`의 `runAsk` 단락 테스트용). 이번에 `req`를 받아 `searchCalls`에 기록하도록 확장했지만 반환값은 그대로 유지해, 기존 `/ask` 관련 테스트들의 동작(단락 경로)에는 영향이 없다.

### 블로커

없음. 추가 지시된 `POST /search` 프록시와 시나리오 (g) 완료·검증됨(전체 103건 통과, 회귀 0건).

## M5 수정 라운드 2

Rocky Linux 컨테이너(`node:22-slim`) 게이트 테스트 중 발견된 크로스플랫폼 버그 수정. `mind /ask`가 LLM을 호출해야 할 때 500과 함께 `[ask-error] fast Error: claude CLI 실행파일을 찾을 수 없습니다 (where.exe claude 실패)`가 발생했다 — `resolveClaudeExePath()`가 Windows 전용 `where.exe`를 무조건 실행하고 있었기 때문이다. 스코프는 `src/llm.ts` + 관련 테스트로 한정.

### 구현 산출물

| 파일 | 역할 |
| --- | --- |
| `src/llm.ts` | `resolveClaudeExePath()`를 플랫폼 분기로 재작성. win32에서는 기존 `where.exe` 로직(`.exe`를 `.cmd`보다 우선)을 바이트 단위로 동일하게 유지하되, 직접 `spawnSync` 호출 대신 주입 가능한 `probe`(`ExeProbeFn`) 함수를 통하도록 바꿨다. 비-win32에서는 `which claude`로 탐색하고, 실패해도(`which` 자체가 없는 컨테이너 포함) 즉시 던지지 않고 `"claude"` 리터럴을 반환해 `spawn()`의 PATH 해석에 위임한다. 새 `claudeNotFoundMessage(platform)`(플랫폼별 탐색 명령을 메시지에 반영), `isEnoentError(err)`, 테스트 전용 `__resetClaudeExePathCacheForTest()`를 추가. `ClaudeCliLlmClient.complete()`의 `child.on("error", ...)` 핸들러가 ENOENT를 감지하면 기존과 동일한 한국어 "찾을 수 없음" 에러로 변환하도록 수정 — PATH 위임으로 미룬 탐색이 spawn 시점에 실패해도 사용자에게 보이는 에러 메시지는 이전과 동일하다. |
| `src/llm.test.ts` | `resolveClaudeExePath`/`ClaudeCliLlmClient`를 대상으로 신규 테스트 6건 추가: win32 성공(.exe 우선)·win32 실패(캐시), 비-win32 성공·실패(exit≠0)·실패(status null, `which` 부재), PATH 위임된 `"claude"` 리터럴이 실제로 없을 때의 ENOENT→한국어 에러 통합 테스트(`ClaudeCliLlmClient.complete()` 경유). 탐색 명령 대역을 만드는 `fakeProbe()` 헬퍼 신설. |

`llm.ts`의 나머지 부분(`resolveTimeoutMs()`, `resolveLlmClient()`, `completeJson()`, `ApiLlmClient`)은 재검토 결과 다른 Windows 전용 가정(경로 구분자, 다른 OS 전용 셸 명령 등)이 없음을 확인 — `ApiLlmClient`는 `fetch` 기반이라 완전히 크로스플랫폼이다.

### 타입체크 & 빌드

```
$ npx tsc --noEmit
(출력 없음, exit 0)

$ npm run build
> cosmos-mind@0.1.0 build
> tsc -p tsconfig.json
(exit 0)
```

### 단위 테스트 (`node --test "dist/**/*.test.js"`)

기존 103건 전원 재확인 + 신규 6건(win32 2건, 비-win32 3건, ENOENT→한국어 에러 1건) 추가로 총 109건. 신규 테스트 통과 라인:

```
✔ win32 분기: where.exe로 탐색하고 .cmd보다 .exe를 우선한다 (0.7609ms)
✔ win32 분기: where.exe 실패 시 즉시 에러를 던지고, 캐시되어 재호출해도 재탐색하지 않는다 (0.3896ms)
✔ 비-win32 분기: which로 탐색해 성공하면 그 경로를 반환한다 (0.1847ms)
✔ 비-win32 분기: which가 실패해도(exit != 0) 즉시 던지지 않고 claude 리터럴로 폴백한다 (0.0956ms)
✔ 비-win32 분기: which 실행 자체가 안 되어도(status null, 컨테이너에 which 없음) claude 리터럴로 폴백한다 (0.0754ms)
✔ PATH 위임된 claude 리터럴이 실제로 없으면 spawn ENOENT를 한국어 '찾을 수 없음' 에러로 변환한다 (6.0968ms)
```

요약 라인:

```
ℹ tests 109
ℹ suites 0
ℹ pass 109
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 326.7861
```

### 편차 / 설계 결정 기록

- **`typeof spawnSync` 대신 최소 커스텀 타입(`ExeProbeResult`/`ExeProbeFn`)을 주입 시그니처로 채택**: Node의 `spawnSync`는 오버로드가 여러 개라 `strict: true` 하에서 테스트용 대역 함수를 타입 안전하게 만들기 번거롭다. 로직이 실제로 소비하는 필드(`status`, `stdout`)만 갖는 인터페이스로 좁혀 `fakeProbe()`가 간단한 순수 함수로 대역을 만들 수 있게 했다.
- **비-win32 실패를 즉시 던지지 않고 `"claude"` 리터럴로 폴백**: team-lead 지시대로, `which`가 없거나 실패해도 정말 `claude`가 미설치인지 최소 컨테이너라 `which`만 없는 것인지 이 시점에는 구분할 수 없다. 판단을 미루고 실제 `spawn()` 시점의 ENOENT로 최종 판정한다 — 오탐(false negative: `which`는 실패했지만 `claude`는 PATH에 있는 경우)을 막기 위한 설계.
- **ENOENT 변환을 `resolveClaudeExePath()`가 아닌 `ClaudeCliLlmClient.complete()`에 배치**: `resolveClaudeExePath()`는 경로 문자열만 반환하는 순수 함수로 남기고, 실제 spawn 실패는 spawn을 수행하는 호출부에서만 감지 가능하므로 `complete()`의 `child.on("error", ...)`에 `isEnoentError()` 체크를 추가했다. 두 실패 경로(win32 `where.exe` 즉시 실패 / 비-win32 PATH 위임 후 지연 실패) 모두 사용자에게는 동일한 한국어 메시지로 수렴한다.
- **`__resetClaudeExePathCacheForTest()` 신설**: `cachedClaudeExePath`는 모듈 레벨 싱글턴 캐시라 같은 테스트 러너 프로세스 안에서 상태가 공유된다. 기존 코드베이스에 `__reset*ForTest` 관례가 없었지만, 캐시를 우회할 다른 방법이 없어 신규 도입했다. 신규 테스트 6건 전부 `try/finally`로 호출 전후 리셋한다.
- **Docker 재빌드/재배포는 이번 스코프에서 제외**: team-lead 지시대로 `src/llm.ts` + 관련 테스트만 수정했다. Rocky Linux 컨테이너에서의 실제 재검증(이미지 재빌드·재배포 후 `/ask` 재호출)은 관리 레인(team-lead) 담당이다.

### 블로커

없음. `resolveClaudeExePath()` 크로스플랫폼 수정과 신규 테스트 6건 완료·검증됨(전체 109건 통과, 회귀 0건). Docker 이미지 재빌드/재배포 후 Rocky Linux 컨테이너에서의 실제 재현 테스트는 이 태스크 스코프 밖(team-lead 담당)이다.

## M6b

- **작업 1 (표기 스윕)**: 사용자-가시 한국어 문자열 "우주"→"코스모스" 치환 완료. 대상 파일: `mind/web/index.html`(제목·로딩·에러 문구 3곳), `mind/web/app.js`(네트워크 에러 메시지 1곳), `mind/web/ask.js`(fixture 답변·불충분 배너 2곳), `mind/web/style.css`(파일 헤더 주석 1곳), `mind/src/server.ts`(라우트 설명 주석 1곳), `mind/src/server.test.ts`(테스트 설명 문자열 1곳, 기대값 동기화), `mcp/src/index.ts`(도구 description 3곳), `mcp/README.md`(설명 1곳), `README.md`(제목 1곳). 코드 식별자(`universe-canvas-mount`, `buildUniverse`, `loadUniverse`, `createUniverseScene` 등)와 API 경로 `/universe`, 파일명 `universe.ts`는 전부 불변. 치환 후 각 대상 파일 grep "우주" 잔존 0건 확인.
- **작업 2 (sync-hub.ps1)**: `tools/sync-hub.ps1` 신규 작성. `data/cosmos_token.txt` 부재 시 로그 1줄 남기고 exit 0. 존재 시 `COSMOS_MIND_URL=http://192.168.0.34:8800`, `COSMOS_TOKEN=<토큰>` 환경변수 설정 후 `node mind/dist/cli.js scan` 실행, JSON 출력을 파싱해 `scanned/ingested/duplicate/replaced/failed` 요약 한 줄을 `data/sync-hub.log`에 append(200줄 초과 시 오래된 줄부터 삭제). 어떤 경로든 항상 exit 0(로그만, 실패로 상위 스케줄을 막지 않음). PS 5.1 제약 준수: 모든 파일 I/O에 `-Encoding utf8` 명시, `node` 네이티브 실행 시 `2>&1` 미사용(ErrorRecord 오염 방지), `&&` 미사용(try/catch 구조).

### 검증
- mind: `npx tsc --noEmit` 0 에러, `npm run build` 성공, `node --test "dist/**/*.test.js"` → tests 113, pass 113, fail 0.
- mcp: `npx tsc -p tsconfig.json` 0 에러.
- 치환 잔존 grep: 대상 9개 파일 전부 "우주" 0건(`grep -n "우주" <file>` exit 1).
- `powershell -NoProfile -ExecutionPolicy Bypass -File D:\cosmos\tools\sync-hub.ps1` 1회 실행 → exit 0, 실 scan 수행(scanned=145 ingested=145 duplicate=140 replaced=4 failed=0), `data/sync-hub.log`에 요약 1줄 정상 append 확인.

## M6a

- 범위: `mind/src/watcher.ts`, `mind/src/config.ts`, `mind/src/watcher.test.ts`, `cosmos.config.json` (4개 파일).
- `config.ts`: `SourceConfig`(`path`, `source_type: "session"|"repo"`, `include_meta?`, `docs_only?`) 신규 타입 + `WatcherConfig.sources?` 선택 필드 추가. `sources` 미검증(cron/policy와 동일 컨벤션), `dirs`/`interval_secs` 하위호환 유지.
- `watcher.ts`: `scanOnce`가 `sources`를 순회하도록 확장. `sources` 부재/빈 배열이면 `dirs`를 `session` 소스로 폴백(기존 동작 100% 유지). `include_meta=true`이면 `dashboard.md`/`MEMORY.md`/`index.md`/`log.md`도 포함하고, `_templates/`는 모드 무관 항상 제외. `docs_only=true`(repo)는 화이트리스트 스캐너(`listDocsOnlyFiles`)로 루트의 `PLAN*.md`/`DESIGN*.md`/`README.md`와 `docs/`·`design/`·`contract/` 하위 재귀 `*.md`만 수집. 전역 제외(모드 무관): 파일명 `RESULTS.md`, 디렉터리 `node_modules`/`target`/`dist`/`.git`/`.omc`/`data`/`models`/`vendor`. 소스 경로가 존재하지 않으면 `console.log`로 스킵 로그만 남기고 에러 없이 다음 소스로 진행. `COSMOS_MIND_URL` 프록시 인제스트 플로우는 변경 없이 재사용.
- `cosmos.config.json`: `watcher.sources`에 세션 2건(memory, wiki — `include_meta: true`)과 레포 14건(`docs_only: true`) 추가. 기존 `watcher.dirs`/`interval_secs`는 폴백용으로 그대로 유지.
- 신규 테스트 4건(`watcher.test.ts`): (a) `sources` 없음 → `dirs` 폴백(session) (b) `docs_only` 필터(PLAN.md/README.md/docs/ 하위 포함, RESULTS.md/node_modules 제외) (c) `include_meta=true` 전환(dashboard.md/MEMORY.md 포함) (d) 부재 경로 스킵(에러 없이 scanned=0, ingest 미호출).
- 검증: `npx tsc --noEmit` 0 errors. 빌드 성공. 전체 테스트 결과:
  ```
  ℹ tests 113
  ℹ suites 0
  ℹ pass 113
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 652.7254
  ```
- 블로커 없음.
