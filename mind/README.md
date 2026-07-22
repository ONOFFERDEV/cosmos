# cosmos-mind (M1)

TypeScript 오케스트레이션 계층. M1 범위는 fast Q&A 파이프라인 하나 — 클러스터 라우팅, core 검색 호출, 안티할루시네이션 가드, 응답 봉투 조립까지. deep 파이프라인·수집기 데몬·웹 UI·MCP 서버는 이후 마일스톤.

Node 22 + TypeScript strict, **런타임 npm 의존성 0**(node:http, node:child_process, node:fs/promises, node:path, 전역 fetch만 사용). `typescript`/`@types/node`만 devDependency. LLM 호출은 커스텀 `LlmClient` 추상화(`src/llm.ts`)로 직접 구현했다 — CONTRACT.md M1 확장 절이 이를 명시하므로, PLAN.md 스택 표의 "Claude Agent SDK" 언급은 이 범위에는 적용되지 않는다.

계약은 `../contract/openapi.yaml` + `../contract/CONTRACT.md`.

## 빌드 & 실행

```
npm install
npm run build   # tsc -> dist/
npm test        # build + node --test
npm start        # node dist/cli.js
```

## CLI

```
node dist/cli.js bootstrap              # core 클러스터 부트스트랩 + LLM 라벨링
node dist/cli.js ask "질문"               # fast Q&A 1회 실행, 응답 봉투를 JSON으로 출력
node dist/cli.js serve [--port 8800]     # POST /ask, GET /health를 제공하는 HTTP 서버
```

## 소스 구성

| 파일 | 역할 |
|---|---|
| `core-client.ts` | cosmos-core(:8801) HTTP 계약 클라이언트 (`CoreClient` 인터페이스 + `CosmosCoreClient`) |
| `llm.ts` | `LlmClient` 추상화 — `claude-cli`(기본, `claude -p` 프로세스 spawn) / `api`(Anthropic Messages API), `COSMOS_LLM` 환경변수로 선택. `completeJson()` 헬퍼 포함 |
| `json-extract.ts` | LLM 응답 텍스트에서 JSON 객체 추출(코드펜스·잡담 텍스트 견딤) |
| `router.ts` | `/route` 점수로 클러스터 consulted/skipped 결정 (`score = centroid_sim + 0.02*min(bm25_hits,10)`, 상위 K=3 + `0.6*top` 임계값) |
| `guard.ts` | 안티할루시네이션 3중 가드. `shouldSkipLlmCall`(LLM 호출 전 단락) + `evaluateInsufficient`(LLM 응답 후 판정) |
| `envelope.ts` | `/ask` 응답 봉투 조립. 인용된 청크만 1..n 재번호 매김 |
| `ask.ts` | fast Q&A 파이프라인 오케스트레이션 + `data/queries.jsonl` 로깅 |
| `bootstrap.ts` | 클러스터 부트스트랩 + LLM 라벨링 + slug 충돌 해소 |
| `server.ts` | `node:http` 서버 (기본 포트 8800) |
| `cli.ts` | `bootstrap`/`ask`/`serve` 서브커맨드 진입점 |

실측 결과와 검증 로그는 `RESULTS.md` 참고.
