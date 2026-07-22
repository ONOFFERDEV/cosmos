# cosmos-mcp

Cosmos M5 — `mind` HTTP API(기본 `http://localhost:8800`)를 감싸는 MCP stdio 브리지.
Claude Code, Claude Desktop 등 MCP 클라이언트에서 Cosmos 지식 코스모스를 직접 질의/검색/편입할 수 있게 한다.

## 설치 및 빌드

```bash
cd D:\cosmos\mcp
npm install
npm run build   # tsc -p tsconfig.json → dist/index.js 생성
```

## `.mcp.json` 등록

```json
{
  "mcpServers": {
    "cosmos": {
      "command": "node",
      "args": ["D:\\cosmos\\mcp\\dist\\index.js"],
      "env": {
        "COSMOS_MIND_URL": "http://localhost:8800",
        "COSMOS_TOKEN": ""
      }
    }
  }
}
```

- `COSMOS_MIND_URL`: mind 서버 base URL (기본값 `http://localhost:8800`, 미설정 시 이 기본값 사용).
- `COSMOS_TOKEN`: 설정 시 모든 요청에 `Authorization: Bearer <COSMOS_TOKEN>` 헤더를 붙인다. 인증이 필요 없으면 비워두거나 생략.

## 제공 도구 (7종)

| 도구 | 설명 |
|---|---|
| `cosmos_ask` | `{question, mode?: "fast"\|"deep"}` — Cosmos에 질문. fast는 약 1분, deep은 여러 클러스터를 순회하며 수 분(최대 20분)까지 걸릴 수 있다. 답변 + 출처 목록 + 경유/건너뜀 궤적 + 비용을 함께 반환. |
| `cosmos_search` | `{query, k?}` — 질의어와 관련된 상위 청크 미리보기. `POST {COSMOS_MIND_URL}/search`를 호출한다(아래 주의 참고). |
| `cosmos_ingest` | `{text?, url?, title?}` — 텍스트 또는 URL을 `manual` 문서로 편입. `url` 지정 시 fetch 후 HTML 태그를 제거해 편입. `text`/`url` 중 하나는 필수. |
| `cosmos_inbox_list` | `{}` — 승인 대기 중인 받은편지함 목록. |
| `cosmos_inbox_approve` | `{ids: string[]}` — 받은편지함 항목들을 id 목록으로 승인. |
| `cosmos_inbox_reject` | `{ids: string[]}` — 받은편지함 항목들을 id 목록으로 거절. |
| `cosmos_status` | `{}` — mind/core 헬스체크 + 클러스터 요약. |

## 사용 예

```
cosmos_ask({ "question": "이번 주 라이선스 서버 작업은 어디까지 진행됐나요?" })
cosmos_ask({ "question": "Cosmos 아키텍처를 core/mind/mcp로 나눈 이유는?", "mode": "deep" })
cosmos_search({ "query": "hybrid search", "k": 5 })
cosmos_ingest({ "url": "https://example.com/article", "title": "예시 기사" })
cosmos_inbox_list({})
cosmos_inbox_approve({ "ids": ["abc123"] })
cosmos_status({})
```

## 구현 메모

- HTTP 클라이언트는 `fetch`(undici)가 아닌 `node:http`/`node:https`를 직접 사용한다. undici는 장시간 요청에서 기본 헤더 타임아웃(약 300초)에 걸릴 수 있어, `cosmos_ask`의 deep 모드(최대 1200초)를 안전하게 지원하기 위함이다. (`cosmos_ingest`의 URL fetch만 예외적으로 표준 `fetch`를 사용 — 일반 웹 페이지 1회성 다운로드라 타임아웃 위험이 낮음.)
- 모든 도구 결과는 JSON 원본이 아니라 사람이 읽기 좋은 한국어 텍스트로 정리해 반환한다.
- 모든 오류는 스택 덤프 없이 한국어 메시지로 반환한다. mind 접속 실패 시 `COSMOS_MIND_URL(...) 접속 실패: ...` 형태로 안내한다.

### 주의: `cosmos_search` / `cosmos_ingest`는 mind 서버에 해당 라우트가 있어야 동작

이 패키지에 주어진 mind API 명세에는 `/search`, `/ingest` 라우트가 포함되어 있었지만, 구현 시점에 실측한 로컬 mind 인스턴스(`http://127.0.0.1:8800`)의 `src/server.ts`에는 아직 `/health`, `/ask`, `/inbox`(+approve/reject), `/universe`만 존재하고 `/search`, `/ingest`는 없었다(병행 진행 중인 "mind 인증·프록시·cron" 작업에서 추가될 것으로 예상). 이 클라이언트는 명세대로 두 엔드포인트를 호출하도록 구현되어 있으며, mind 쪽에 라우트가 배포되면 별도 수정 없이 정상 동작한다. 라우트가 없는 동안에는 `cosmos_search`/`cosmos_ingest` 호출 시 `mind /search 요청 실패 (status 404): ...` 같은 명확한 한국어 오류가 반환된다(스택 덤프 아님). 실측 결과는 `RESULTS.md` 참고.
