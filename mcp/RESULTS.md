# cosmos-mcp 검증 결과 (실측)

검증 일시: 2026-07-14, 로컬 mind 인스턴스 `http://127.0.0.1:8800` 대상.

## 1. npm install / 빌드 / 타입체크

```
$ npm install
added 96 packages, and audited 97 packages in ...
0 vulnerabilities
```

```
$ npx tsc -p tsconfig.json
(출력 없음 — 0 에러)
```

```
$ node --check dist/index.js
$ node --check dist/mind-client.js
check-ok
```

빌드 산출물: `dist/index.js`, `dist/mind-client.js` (+ `.js.map`, `.d.ts`) 정상 생성 확인.

## 2. stdio 스모크 테스트 (initialize → tools/list)

`node dist/index.js`를 자식 프로세스로 띄우고 stdin으로 JSON-RPC 메시지를 보내 확인했다 (스크립트는 검증 전용으로 스코프 밖 scratchpad에 작성, mcp/ 디렉터리에는 포함하지 않음).

```
=== initialize response ===
{
  "name": "cosmos-mcp",
  "version": "0.1.0"
}

=== tools/list ===
tool count: 7
cosmos_ask, cosmos_search, cosmos_ingest, cosmos_inbox_list, cosmos_inbox_approve, cosmos_inbox_reject, cosmos_status
```

→ 7종 도구 전부 정상 등록·응답 확인.

## 3. 실제 도구 호출 (로컬 mind, `COSMOS_MIND_URL=http://127.0.0.1:8800`)

### `cosmos_status` — 성공

```json
{
  "content": [
    {
      "type": "text",
      "text": "상태: ok\n문서 153개, 청크 759개, 클러스터 5개\n\n클러스터 5개:\n  - 프로젝트 횡단 기술 트러블슈팅 노트와 협업 디렉티브 (cross-project-tech-notes-and-directives): 문서 12개\n  - 인디 SaaS 라이선싱·페이월 인프라 (indie-saas-licensing-paywall-infra): 문서 40개\n  - 메모리 온톨로지 및 MOC 체계 (memory-ontology-moc): 문서 14개\n  - 멀티에이전트 워크플로 및 프로젝트 기술 교훈 (multi-agent-workflow-lessons): 문서 7개\n  - 개인 프로젝트 현황 & 개발 인프라 노하우 (personal-project-portfolio-dev-infra): 문서 80개"
    }
  ]
}
```

`GET /health` + `GET /universe`를 병렬 호출해 실데이터(문서 153개, 청크 759개, 클러스터 5개)를 정확히 가져와 사람이 읽기 좋은 한국어로 정리함을 확인.

### `cosmos_inbox_list` — 성공

```json
{ "content": [ { "type": "text", "text": "받은편지함이 비어 있습니다." } ] }
```

`GET /inbox`가 빈 배열을 반환하는 실제 상태를 정확히 반영.

### `cosmos_search` — 예상된 실패 (blocker, 구현 결함 아님)

```json
{
  "content": [
    { "type": "text", "text": "mind /search 요청 실패 (status 404): {\"message\":\"찾을 수 없는 경로입니다.\"}" }
  ],
  "isError": true
}
```

로컬 mind의 `src/server.ts`에 아직 `/search` 라우트가 배포되지 않아 404가 발생. mind API 명세(과업 지시)에는 `/search`가 없었으나 `cosmos_search` 도구 자체는 요구사항이었으므로, core의 `/search` 계약(`core-client.ts` 기준: `{query,k?}` → `{results:[...]}`)을 mind가 그대로 프록시한다고 가정하고 구현했다. 병행 진행 중인 "M5 mind 인증·프록시·cron" 작업에서 해당 라우트가 mind에 추가되면 코드 수정 없이 정상 동작할 것으로 예상된다. 오류 메시지는 스택 덤프 없이 한국어로 명확히 반환됨을 확인했다(요구사항 충족).

### `cosmos_ingest` — 미실행 (실측 보류)

`/ingest`도 같은 이유로 로컬 mind에 라우트가 아직 없어(코드 조사 결과) 실호출 시 동일한 404 패턴이 예상된다. 불필요한 실데이터 편입(문서 오염) 위험을 피하기 위해 이번 검증에서는 실제 호출을 생략했다. 구현은 명세대로 완료되어 있으며, mind 쪽 라우트가 배포된 후 `cosmos_ingest({text:"..."})` 형태로 재검증 가능.

### `cosmos_ask` — 미실행 (실측 보류)

fast 모드 기준 최대 300초까지 걸릴 수 있는 실LLM 호출이라, 이번 검증 세션에서는 시간·비용 문제로 실호출을 생략했다. `/ask` 라우트는 로컬 mind에 이미 존재함(server.ts에서 확인)이 확인되어 구조적으로는 즉시 사용 가능한 상태다.

### `cosmos_inbox_approve` / `cosmos_inbox_reject` — 미실행 (실측 보류)

받은편지함이 비어 있어(위 `cosmos_inbox_list` 결과) 실제 승인/거절 대상 id가 없었다. 구현은 `POST /inbox/{id}/approve`, `POST /inbox/{id}/reject`를 그대로 호출하며, 받은편지함에 대기 항목이 생기면 재검증 가능.

## 4. Blocker / 주의사항 요약

- **`cosmos_search`, `cosmos_ingest`는 mind 서버에 `/search`, `/ingest` 라우트가 배포되어야 동작한다.** 검증 시점(2026-07-14) 기준 로컬 mind에는 두 라우트가 없어 `cosmos_search`는 실측 404를 재현했다. mind 쪽 라우트 추가는 별도 병행 작업("M5 mind 인증·프록시·cron")의 범위이며, 본 mcp 패키지는 명세된 계약대로 구현을 완료했으므로 라우트 배포 후 별도 코드 수정 없이 동작해야 한다.
- 스코프 준수: 이번 작업에서 생성/수정한 파일은 모두 `D:\cosmos\mcp\` 하위에만 존재한다(`package.json`, `tsconfig.json`, `.gitignore`, `src/index.ts`, `src/mind-client.ts`, `README.md`, `RESULTS.md`, 빌드 산출물 `dist/`, `node_modules/`). 검증용 스모크 테스트 스크립트는 스코프 보존을 위해 `D:\cosmos\mcp\` 바깥의 임시 scratchpad 경로에 작성했으며 리포지토리에 포함되지 않는다.
- npm 의존성은 `@modelcontextprotocol/sdk`, `zod`(런타임)와 `typescript`, `@types/node`(devDependencies)만 추가했다.
