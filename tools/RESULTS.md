# M0 시드 수집 + 평가 하네스 — 실측 결과

## 시드 수집 (`collect_seed.mjs` 실행 결과, 2026-07-13)
| 소스 | 건수 |
|---|---|
| wiki (`~/.claude/wiki/*.md`, index.md·log.md 제외) | 84 |
| memory (`~/.claude/projects/D--/memory/*.md`, MEMORY.md·dashboard.md·_templates/ 제외) | 45 |
| **총 문서 수** | **129** |

`manifest.json` 엔트리 수(129)가 실제 복사된 파일 수(wiki 84 + memory 45)와 정확히 일치함을 확인.

## 평가셋 (`eval/questions.json`) — 12문항
위키 페이지 12개에서 1문항씩, 6개 이상 토픽 클러스터 요건을 충족하며 실제로는 12개 서로 다른 클러스터를 커버:

| id | 클러스터 | gold 페이지 |
|---|---|---|
| q01 | Windows 프로세스 실행 지뢰 | windows-spawn-cmd-quoting-mines.md |
| q02 | Rust/ONNX 폐쇄망 배포 | ort-onnxruntime-rust-windows-airgap.md |
| q03 | Tauri FFI Send/Sync | tauri-mutex-engine-pdfium-thread-safe-send.md |
| q04 | Cloudflare 비용 모델 | cloudflare-do-cost-model.md |
| q05 | 게임 서버 세션 보안 | tikron-session-key-is-broadcast.md |
| q06 | 로컬 LLM 구조화 추출 | ollama-sidecar-airgap-extraction.md |
| q07 | 한글 HWP 복호화 | hwp-distdoc-viewtext-decrypt.md |
| q08 | 한국 전자지급결제대행업 법규 | korea-secondary-pg-unregistered-boundary.md |
| q09 | Rust tantivy 검색 파서 | tantivy-queryparser-natural-language-syntax-error.md |
| q10 | 한국 정부 Open API 인코딩 | law-go-kr-openapi-korean-query-encoding.md |
| q11 | WebGPU 헤드리스 렌더링 검증 | webgpu-tsl-softbody-headless-verify-dispatch-opt.md |
| q12 | 한국 철도 예매 라이브러리 | korail2-reservation-not-in-app-cart.md |

각 문항은 해당 페이지의 고유 기술 내용(예: q07의 MSVC rand() LCG 키 유도, q06의 JSON Schema 강제 트릭)을 겨냥한 자연어 질문 형태로 작성했으며, 페이지 제목을 그대로 베낀 키워드형 질문은 없음.

## `eval_search.mjs` 검증
- `node --check tools/eval_search.mjs` — 통과 (문법 오류 없음).
- 별도 검증 스크립트로 `questions.json`의 `gold_files` 12건 전부가 `manifest.json`의 origin 베어 파일명과 정확히 매칭됨을 확인 (누락 0건).
- cosmos-core(포트 8801)가 아직 구현/기동되지 않아 **실제 hit@6 측정은 미실행**. core가 `M0 게이트` 3개 항목(`cargo build` 0 에러, `anchor_mismatches == 0`, `/health` 응답)을 충족한 뒤 `node eval_search.mjs`로 측정 필요. 목표: hit@6 ≥ 10/12 (CONTRACT.md M0 게이트 §3).

## 블로커
- 없음 (내 담당 범위인 `tools/`, `data/seed/` 산출물은 전부 완료). hit@6 실측은 core 구현(m0-core-rust 레인) 완료가 선행 조건.

## M1

## 평가셋 (`eval/questions_ask.json`) — 13문항 (긍정 10 + 부정 3)

| id | 구분 | gold / 기대 |
|---|---|---|
| q01~q10 | 긍정(`expect:"answer"`) | M0 `questions.json`의 q01~q10을 질문 원문·gold_files 그대로 재사용 |
| q11 | 부정(`expect:"insufficient"`) | 대법원 이혼 재산분할 판례 판단 기준 |
| q12 | 부정(`expect:"insufficient"`) | Kubernetes HPA(Horizontal Pod Autoscaler) 커스텀 메트릭 튜닝 |
| q13 | 부정(`expect:"insufficient"`) | 양자 오류정정 표면코드(surface code) 논리/물리 큐비트 오류율 관계 |

긍정 10문항은 M0 12문항 중 q11(WebGPU 헤드리스 렌더링 검증)·q12(korail2 예약)를 제외한 q01~q10을 질문 텍스트·gold_files 변경 없이 그대로 재사용했다. 두 문항을 뺀 것은 12문항 중 10개만 필요해 앞쪽 10개를 채택한 것뿐이며, 비게 된 id 11·12는 새 부정 문항에 재배정하고 id 13을 추가했다(총 13문항).

## 부정 문항 코퍼스 부재 검증

`data/seed/manifest.json` 129건(위키 84 + 메모리 45) 파일명·제목 전수 확인 결과 세 부정 주제와 직접 연관된 문서는 없었다. 파일명 수준을 넘어 실제 소스 디렉터리(`~/.claude/wiki`, `~/.claude/projects/D--/memory` — `collect_seed.mjs`가 이 두 경로를 변형 없이 그대로 복사하므로 소스 원문 = 시드 콘텐츠) 전체를 다음 패턴으로 전문(全文) grep했다.

패턴: `이혼|재산분할|쿠버네티스|Kubernetes|HPA|Horizontal Pod Autoscaler|양자 오류정정|표면코드|surface code|큐비트|qubit` (대소문자 무시)

매치 3건, 개별 확인 결과 전부 실질적 정답 근거가 되지 못함을 확인했다.

1. `graph-rag-topic-dense-corpus-cross-doc-edges.md`(위키): "이혼"이 그래프 RAG 엔티티 공유를 설명하는 예시 토픽 목록(징계해고·이혼·상속·계약해제) 중 단어 하나로만 등장. 이혼 재산분할의 실질 판단 기준을 서술하는 내용은 없음.
2. `docseal-onprem-doc-ai.md`(메모리, 35행): "이혼"/"재산분할"이 한 줄에 밀집 등장하지만, 실제 내용은 **별개 프로젝트(Docseal)가 자체 판례 코퍼스에 "이혼재산분할" 질문을 던졌더니 실제 주제(이혼 가사법)가 코퍼스에 미수집이라 표면적 키워드 일치("재산분할"→상속재산분할 오회수)에 속지 않고 `insufficient=true`로 정상 차단했다는 실험 결과 기록**이다. 이혼 재산분할의 실질 법리·비율 산정 기준을 서술하는 문장이 아니라 오히려 "이 주제는 근거가 없어서 막았다"는 메타 진술이므로, Cosmos 코퍼스 안에서도 부정 문항 근거로 안전하다.
3. `plugin-paywall-remote-flag.md`(메모리, 50행): 대소문자 무시 매치 `hpa`는 실제로는 단어 `scratchpad`(scrat**chpa**d) 내부의 부분 문자열이며 Kubernetes/HPA와 전혀 무관한 오탐(Figma 데스크톱 하드닝 관련 문단).

세 건 모두 실질 콘텐츠 없음을 확인해 원래 후보 3주제(대법원 이혼 재산분할 판례, Kubernetes HPA 튜닝, 양자 오류정정 표면코드)를 그대로 채택했다.

## 검증

- `node --check tools/eval/judge_ask.mjs` — 통과.
- `node --check tools/eval/judge_ask.test.mjs` — 통과.
- `node --check tools/eval_ask.mjs` — 통과.
- `questions_ask.json` JSON 파싱 검증 — 통과, 13문항(긍정 10 · 부정 3) 확인.
- `node --test tools/eval/judge_ask.test.mjs` 실행 결과(전체 인용, 정답/오답/trace 결여 케이스 포함 10건 전부 통과):

```
✔ judgeAnswer: 정답 - insufficient=false + gold 인용 → PASS (0.7424ms)
✔ judgeAnswer: 오답 - insufficient=false이나 gold 미인용 → FAIL (0.1425ms)
✔ judgeAnswer: 부정 문항 - insufficient=true → PASS (0.5103ms)
✔ judgeAnswer: 부정 문항이나 insufficient=false → FAIL (0.0835ms)
✔ judgeTrace: trace 결여(빈 배열) → FAIL (0.1132ms)
✔ judgeTrace: consulted+skipped+why 전부 있음 → PASS (0.0744ms)
✔ judgeTrace: why가 빈 문자열이면 FAIL (0.0652ms)
✔ judgeTrace: skipped 없음 → FAIL (0.0625ms)
✔ basename: 윈도우 경로에서 파일명만 추출 (0.0959ms)
✔ topCitedFile: sources[0] 파일명 반환, 없으면 null (0.1488ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 68.1662
```

- mind 서버(포트 8800)가 아직 구현/기동되지 않아 **실제 `/ask` E2E 측정은 미실행**(관리/검증은 본체 담당, task #14). `eval_ask.mjs`는 mind 기동 후 `node eval_ask.mjs`로 즉시 실행 가능하도록 완성되어 있다.

## 블로커

- 없음 (내 담당 범위인 `tools/eval/questions_ask.json`, `tools/eval_ask.mjs`, `tools/eval/judge_ask.mjs` + 자가테스트는 전부 완료·검증). 실제 M1 게이트 측정(긍정 ≥ 8/10 · 부정 = 3/3 · trace 전건)은 mind 서버(core 클러스터·라우팅 포함) 구현·기동이 선행 조건.

## M2

## 구현 요약

CONTRACT.md "# M2 확장"의 "M2 게이트" 6항(수집·미색인 증명 / 승인 종단 / 거부 / 워처 3상태 / manual 2건 / 종합 판정)을 실측하는 게이트 스크립트를 `eval_ask.mjs`/`judge_ask.mjs` 스타일(의존성 0, 판정 함수 분리, 표+report json)로 구현했다.

- `tools/eval/judge_m2.mjs` — 순수 판정 함수 11개(+헬퍼 2개) export. `extractJsonBlob`(mind CLI stdout에서 JSON 블록 추출, 3단계 폴백), `citesOrigin`, `judgeAskUncited`/`judgeAskCited`(미인용/인용 증명), `judgeUnindexedProof`(collect 직후 docs 불변+pending≥1), `judgeApproveEndToEnd`(docs+1·cluster_slug·fit 존재), `judgeJournalHasIngestAndAssign`(저널 ingest+assign 이벤트), `judgeReject`(docs 불변+pending 제거+rejected 기록), `judgeIngestTriple`(신규/동일/수정 3상태), `judgeDocsUnchanged`(실 스캔 무손상), `judgeManualImmediate`(manual 즉시색인).
- `tools/eval/judge_m2.test.mjs` — `node:test` 자가테스트 38케이스(요구 최소 6건의 6배 이상), 11개 함수 전부 PASS/FAIL 양쪽 경로 커버.
- `tools/eval_m2.mjs` — 5게이트 순차 실행 오케스트레이션. `runMindCli()`가 `node D:\cosmos\mind\dist\cli.js <cmd>`를 child_process로 실행하며 항상 `{code, stdout, stderr, timedOut}`로 resolve(reject 없음, `safeGate()`가 개별 게이트 예외를 격리). core `/health`·`/docs`·`/ingest`·`/journal`, mind `/ask` HTTP 헬퍼 포함. 콘솔 표 + `tools/eval/report_m2.json` 산출, 전체 PASS 아니면 `process.exitCode=1`.
- 게이트4(워처)는 명세대로 `mind CLI scan`에 `--dirs <임시디렉터리>` override를 우선 시도하고, 실패 시(현재 실제 경로) `core /ingest` 직접 호출로 동등 검증(신규 chunks>0·동일 duplicate:true·수정 replaced:true)하며, 어느 경로였는지 `report_m2.json`의 `watcher_method` 필드(`"cli_scan_dirs"` | `"core_ingest_direct"`)에 기록한다. 이어 실제 `mind scan`(디렉터리 override 없이, memory+wiki 전체) 1회로 기존 129건 무손상(`/docs` 수 불변)을 별도 단언한다.
- 게이트5(manual)는 임시 로컬 md 1건 + `https://example.com` 1건을 ingest해 즉시색인만 확인하고, core에 색인된 두 문서 자체는 정리하지 않는다(스펙 "표시만, 정리는 관리자" 준수). 스크립트 자신의 로컬 임시 디렉터리(`tools/.m2_manual_tmp/`, `tools/.m2_watch_tmp/`)는 각 게이트가 실행 후 스스로 삭제한다.

## 검증

- `node --check tools/eval/judge_m2.mjs` — 통과.
- `node --check tools/eval/judge_m2.test.mjs` — 통과.
- `node --check tools/eval_m2.mjs` — 통과.
- `node --test tools/eval/judge_m2.test.mjs` 실행 결과(전체 인용, 38케이스 전부 통과):

```
✔ extractJsonBlob: 전체 문자열이 순수 JSON이면 그대로 파싱 (0.9637ms)
✔ extractJsonBlob: 로그 줄 뒤에 마지막 줄이 JSON이면 그 줄을 파싱 (0.1097ms)
✔ extractJsonBlob: 앞뒤 로그에 섞인 균형 중괄호 블록을 뒤에서부터 스캔해 파싱 (0.0901ms)
✔ extractJsonBlob: 파싱 불가능한 문자열은 null (0.0779ms)
✔ extractJsonBlob: 빈 문자열/비문자열 입력은 null (0.0658ms)
✔ citesOrigin: sources에 origin이 정확히 일치하면 true (0.0793ms)
✔ citesOrigin: sources에 origin이 없으면 false (0.0764ms)
✔ citesOrigin: sources가 없는 envelope도 false(예외 없이) (0.0519ms)
✔ judgeAskUncited: 미인용이면 PASS (0.1466ms)
✔ judgeAskUncited: 승인 전인데 이미 인용되면 FAIL (0.2104ms)
✔ judgeAskCited: 승인 후 인용되면 PASS (0.158ms)
✔ judgeAskCited: 승인 후에도 미인용이면 FAIL (0.0642ms)
✔ judgeUnindexedProof: docs 불변 + pending>=1 이면 PASS (0.0656ms)
✔ judgeUnindexedProof: docs 수가 변동하면 FAIL (0.0643ms)
✔ judgeUnindexedProof: pending이 0건이면 FAIL (0.038ms)
✔ judgeApproveEndToEnd: docs+1, cluster_slug·fit 존재면 PASS (0.0581ms)
✔ judgeApproveEndToEnd: docs가 +1 안 되면 FAIL (0.034ms)
✔ judgeApproveEndToEnd: ingestEntry 없으면 FAIL (0.0273ms)
✔ judgeApproveEndToEnd: cluster_slug가 null이면 FAIL (0.0295ms)
✔ judgeApproveEndToEnd: fit이 숫자가 아니면 FAIL (0.0252ms)
✔ judgeJournalHasIngestAndAssign: ingest+assign 둘 다 있으면 PASS (0.0521ms)
✔ judgeJournalHasIngestAndAssign: assign이 없으면 FAIL (0.0361ms)
✔ judgeJournalHasIngestAndAssign: 빈 배열이면 둘 다 없음 FAIL (0.0311ms)
✔ judgeReject: 정상 거부(docs 불변, pending 제거, rejected 기록)면 PASS (0.0487ms)
✔ judgeReject: 거부인데 docs 수가 변하면 FAIL (0.0278ms)
✔ judgeReject: pending에 여전히 파일이 남아있으면 FAIL (0.0253ms)
✔ judgeReject: rejected 파일이 없으면 FAIL (0.0241ms)
✔ judgeIngestTriple: 신규/동일/수정 3상태가 모두 정상이면 PASS (0.0476ms)
✔ judgeIngestTriple: 동일 재전송인데 duplicate가 false면 FAIL (0.0274ms)
✔ judgeIngestTriple: 신규 전송의 chunks가 0이면 FAIL (0.0292ms)
✔ judgeIngestTriple: 수정 재전송의 replaced가 false면 FAIL (0.0246ms)
✔ judgeDocsUnchanged: 전후 동일하면 PASS (0.0302ms)
✔ judgeDocsUnchanged: 전후가 다르면 FAIL (0.0364ms)
✔ judgeManualImmediate: 신규 색인(chunks>0)이면 PASS (0.0336ms)
✔ judgeManualImmediate: 재실행으로 duplicate:true여도 PASS (0.0349ms)
✔ judgeManualImmediate: doc_id가 없으면 FAIL (0.0297ms)
✔ judgeManualImmediate: entry가 null이면 FAIL (0.0348ms)
✔ judgeManualImmediate: chunks도 0이고 duplicate도 false면 FAIL(즉시색인 실패) (0.0239ms)
ℹ tests 38
ℹ suites 0
ℹ pass 38
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 72.2564
```

- 실 서버(core:8801, mind:8800) E2E 실행은 지시에 따라 수행하지 않음("실 서버 E2E 실행은 관리자 몫 — 하지 말 것"). `eval_m2.mjs`는 두 서버 기동 후 `node eval_m2.mjs`로 즉시 실행 가능하도록 완성되어 있다.

## 블로커

- **mind CLI에 M2 서브커맨드(`collect`/`inbox`/`approve`/`reject`/`scan`)가 아직 구현되어 있지 않음.** `mind/src/cli.ts`를 재확인한 결과 `bootstrap | ask "질문" | serve [--port]` 세 개만 존재하며 그 외 명령은 `default` 분기에서 `알 수 없는 명령: ...` 예외를 던진다. 이 때문에 게이트1(collect)·게이트2(approve)·게이트3(reject)·게이트4(scan)는 현재 상태로 `eval_m2.mjs`를 실행하면 CLI 비정상 종료(code≠0)로 즉시 FAIL 처리된다(스크립트 자체는 이 실패를 정상적으로 캐치해 FAIL 사유를 report에 남기고 죽지 않는다).
- **core에 ingest 시 클러스터 자동배정(`cluster_slug`/`fit`) 기능이 아직 구현되어 있지 않을 가능성.** `openapi.yaml`상 `IngestResponse.ingested[].cluster_slug`/`fit`는 스키마에 존재(M2 확장 필드)하나 실제 core 구현 여부는 core 레인 담당.
- 위 두 기능(mind M2 CLI, core 클러스터 자동배정)이 구현·기동된 뒤에야 실제 M2 게이트 5개 실측이 가능하다. `tools/` 범위 내 산출물(`judge_m2.mjs`, `judge_m2.test.mjs`, `eval_m2.mjs`)은 전부 완료·자가검증되어 있으며, 선행 구현이 끝나는 즉시 `node eval_m2.mjs` 실행만으로 실측 가능하다.

## M2 백로그 처리

CONTRACT.md "## M2 백로그 처리"의 지시: *"eval_m2 게이트2 측정 채널 수정: CLI stdout JSON 파싱 가정 폐기 → approved/{id}.json의 cluster_slug·fit 존재 + core /docs origin 실재 + docs 증가로 판정(2026-07-13 수동 검증과 동일 증거 채널). judge 테스트 갱신 포함."*

- **이전 채널**: 게이트2(`gate2_approveEndToEnd`)가 `mind CLI approve` 실행의 stdout을 `extractJsonBlob()`으로 파싱해 그 결과(`ingestEntry`)를 승인 성공의 증거로 삼았다. CLI가 로그 라인 사이에 JSON을 섞어 찍는 경우를 3단계 폴백으로 방어했지만, 근본적으로 "CLI가 JSON을 stdout에 어떤 형태로든 찍는다"는 가정 자체가 core의 실제 상태 변화와 무관한 간접 증거였다.
- **새 채널**: `judge_m2.mjs`의 `judgeApproveEndToEnd({docsBefore, docsAfterApprove, approvedEntry, origin, docsAfterList})`로 교체. 세 가지 실제 증거만 확인한다.
  1. `core /docs` 문서 수가 승인 전후로 실제로 증가했는가(`docsAfterApprove > docsBefore`, CONTRACT.md의 "증가" 표현 그대로 채택 — 이전의 암묵적 "+1 정확히" 가정보다 느슨하게 완화).
  2. `data/inbox/approved/{id}.json`이 실재하고 `cluster_slug`·`fit`이 채워져 있는가(`findInboxEntry(APPROVED_DIR, id)`로 파일시스템에서 직접 읽음, CLI stdout 경유 없음).
  3. 그 origin이 `core /docs` 실제 목록에 존재하는가(개수 증분만으로 추론하지 않고 origin 값 자체의 실재를 확인).
- `eval_m2.mjs`의 `gate2_approveEndToEnd()`를 이미 존재하던 `coreDocs()`(`/docs` 파싱 헬퍼)·`findInboxEntry()`(승인 파일 읽기 헬퍼) 조합으로 재작성했고, `extractJsonBlob` import를 제거했다(다른 게이트·테스트에서는 계속 쓰이므로 `judge_m2.mjs`에서 export 자체는 유지).
- `judge_m2.test.mjs`의 `judgeApproveEndToEnd` 테스트를 5건 → 8건으로 확장, 신규 증거 채널(origin이 docsAfterList에 없음, docsAfterList가 빈 배열)과 추가 엣지 케이스(docs가 감소하는 경우)를 새로 커버했다.

## M3

## 평가셋 (`eval/questions_deep.json`) — 6문항 (긍정 교차클러스터 5 + 부정 1)

| id | 대상 클러스터 쌍 | 의도 |
|---|---|---|
| qd01 | `personal-project-portfolio-dev-infra` × `multi-agent-workflow-lessons` | 최근 arXiv 멀티에이전트 조정 논문(WebSwarm 등)과 실제 겪은 fleet 모니터링/봇 채움 결함/계약 드리프트 교훈을 교차 비교하도록 유도 |
| qd02 | `indie-saas-licensing-paywall-infra` × `personal-project-portfolio-dev-infra` | Cloudflare AI 에이전트 플랫폼 발표(Flue SDK 등)와 Tikron Durable Objects 원가·세션 보안 이슈를 교차 비교 |
| qd03 | `memory-ontology-moc` × `cross-project-tech-notes-and-directives` | 메모리의 PowerShell UTF-8 손상 교훈과 위키의 PS5.1 BOM 지뢰 기술노트를 종합·비교 |
| qd04 | `personal-project-portfolio-dev-infra` × `indie-saas-licensing-paywall-infra` | Figma 플러그인 원격 페이월 전환 결정과 위키의 원격 페이월 config 패턴·라이선스 서버 인증 아키텍처를 연결 |
| qd05 | `multi-agent-workflow-lessons` × `cross-project-tech-notes-and-directives` | 병렬 에이전트 계약 드리프트 문제와 시드 결정성·봉인 평가셋 운용 원칙을 종합 |
| qd06(부정) | 없음(`expected_clusters: []`) | 극자외선(EUV) 리소그래피 펠리클/레지스트 트레이드오프 — 코퍼스에 전혀 없는 반도체 물리 주제로, `insufficient=true` 강제 여부만 확인하는 의도적 out-of-corpus 대조군 |

각 긍정 문항은 실제 코퍼스에 존재하는 서로 다른 두 클러스터의 문서를 각각 최소 1건 이상 근거로 요구하도록 설계했다(`gold_files_any`에 양쪽 클러스터 파일이 모두 나열됨). 단일 클러스터 안에서도 답이 나올 수 있는 애매한 질문은 배제하고, 질문 자체가 "비교/연결/종합"을 명시적으로 요구하는 형태로만 작성했다. qd06은 위키·메모리 코퍼스 129건 전체에서 EUV/펠리클/레지스트/노광선량 관련 키워드가 전혀 없음을 사전 확인한 뒤 채택했다(M1 부정 문항 채택 시와 동일한 grep 검증 방식).

## 구현 요약

CONTRACT.md "# M3 확장"의 deep envelope 스키마와 "M3 게이트(A/B)" 4개 기준(기준1 클러스터 다양성, 기준2 신규 출처 회수, 기준3 trace 완전성, 부정 insufficient)을 실측하는 A/B 하네스를 `eval_ask.mjs`/`eval_m2.mjs`와 동일한 스타일(의존성 0, 판정 함수 분리, 표+report json)로 구현했다.

- `tools/eval/judge_deep.mjs` — 순수 판정 함수 5개(+헬퍼 1개) export: `originsOf`(sources에서 origin 추출), `clustersOfSources`(origin→cluster 근사 맵으로 등장 클러스터 Set 산출, 미매핑 origin은 조용히 무시), `judgeMultiClusterCitation`(기준1: 서로 다른 클러스터 ≥2), `judgeNewSourceRecovery`(기준2: fast에 없던 origin을 deep이 ≥1건 신규 회수), `judgeTraceCompleteness`(기준3: 전 active 클러스터가 trace에 `consulted`+`subquestion` 또는 `skipped`+`why`로 정상 등장), `judgeNegativeInsufficient`(부정: `insufficient===true`).
- `tools/eval/judge_deep.test.mjs` — `node:test` 자가테스트 15케이스, 5개 함수 전부 PASS/FAIL 양쪽 경로(+ trace 결측/malformed 세부 케이스) 커버.
- `tools/eval_deep.mjs` — 문항별 fast(`/ask{question}`) → deep(`/ask{question, mode:"deep"}`) 순차 실행(deep은 CONTRACT.md 명세대로 전역 직렬이므로 병렬화하지 않음) 오케스트레이션. mind·core `/health` 확인 → `questions_deep.json` 순회 → 판정 → 콘솔 표(문항별 fast/deep 출처수·클러스터수·신규회수건수·경과초·C1/C2/C3/부정 마크) + 게이트 요약(✅/❌) 출력 → `tools/eval/report_deep.json`에 fast/deep 원본 envelope 전체 보존. 지연시간(`fastSecs`/`deepSecs`)과 `cost.llm_calls` 합계는 참고용으로만 기록하고 게이트 판정에는 관여하지 않는다(CONTRACT.md 명시대로).
- **클러스터 매핑 근사 방법**(기준1·표시용 클러스터수에 필요, core에는 origin→cluster_slug 직접 조회 엔드포인트가 없음 — `openapi.yaml` 확인 결과 `GET /docs`의 `DocSummary`에 cluster 필드 없음, `GET /clusters`의 `ClusterSummary`에 문서 목록 없음):
  1. **1순위**: active 클러스터마다 core `POST /search`를 `cluster_ids=[cluster.id]`로 스코프하고 `query`에 클러스터 name/slug, `k=max(cluster.n_docs, 50)`으로 호출해 `results[].origin`을 회수, `origin→cluster.slug` 맵에 채운다.
  2. **2순위(보충)**: core `GET /journal`의 `kind==="assign"` 이벤트에서 `payload.origin`과 `payload.cluster_slug`(또는 `payload.cluster_id`→slug 역참조, 또는 `payload.slug`)를 방어적으로 추출해 1순위가 못 채운 origin만 보충한다(payload 스키마가 계약상 자유형이라 여러 필드명 후보를 시도).
  - **명시된 한계**: 질의어와 무관한 저순위 문서는 `cluster_ids` 스코프 안에서도 top-k 밖으로 밀려 근사 맵에서 누락될 수 있다. 완전한 매핑을 보장하지 않으며, 이 방법과 경고는 `report_deep.json`의 `origin_cluster_map_method`/`origin_cluster_map_warnings` 필드에 실행 시점마다 그대로 기록된다. 각 클러스터 `/search` 호출 또는 journal 폴백이 개별 실패해도 전체 게이트 실행은 멈추지 않고 warnings에 누적한다.

## 검증

- `node --check tools/eval/judge_deep.mjs` — 통과.
- `node --check tools/eval/judge_deep.test.mjs` — 통과.
- `node --check tools/eval_deep.mjs` — 통과.
- `node --check tools/eval/judge_m2.mjs` — 통과(M2 백로그 수정 반영 후 재검증).
- `node --check tools/eval_m2.mjs` — 통과(M2 백로그 수정 반영 후 재검증).
- `node --check tools/eval/judge_m2.test.mjs` — 통과(테스트 갱신 후 재검증).
- `questions_deep.json` JSON 파싱 검증 — 통과, 6문항(긍정 교차클러스터 5 · 부정 1) 확인.
- `node --test tools/eval/judge_deep.test.mjs` 실행 결과(전체 인용, 15건 전부 통과):

```
✔ originsOf: sources[]에서 origin만 순서대로 추출 (1.3996ms)
✔ clustersOfSources: 매핑에 있는 origin만 클러스터 슬러그로 모음(미매핑은 무시) (0.1153ms)
✔ judgeMultiClusterCitation: 서로 다른 클러스터 2개 인용 시 PASS (0.106ms)
✔ judgeMultiClusterCitation: 클러스터 1개만 인용 시 FAIL (0.1162ms)
✔ judgeMultiClusterCitation: 맵에 전혀 매핑되지 않으면 0개로 FAIL (0.0685ms)
✔ judgeNewSourceRecovery: deep이 fast에 없던 origin을 회수하면 PASS (0.0881ms)
✔ judgeNewSourceRecovery: deep 출처가 fast의 부분집합이면 FAIL (0.0616ms)
✔ judgeNewSourceRecovery: 신규 출처 중복은 한 번만 집계 (0.0819ms)
✔ judgeTraceCompleteness: 전 active 클러스터가 consulted/skipped로 정상 등장하면 PASS (0.1405ms)
✔ judgeTraceCompleteness: 클러스터가 trace에서 통째로 빠지면 FAIL (0.1129ms)
✔ judgeTraceCompleteness: consulted인데 subquestion이 빈 문자열이면 FAIL (0.0809ms)
✔ judgeTraceCompleteness: skipped인데 why가 없으면 FAIL (0.0725ms)
✔ judgeNegativeInsufficient: insufficient === true면 PASS (0.0733ms)
✔ judgeNegativeInsufficient: insufficient === false면 FAIL (0.039ms)
✔ judgeNegativeInsufficient: insufficient 필드 자체가 없으면 FAIL (0.0289ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 288.7863
```

- `node --test tools/eval/judge_m2.test.mjs` 실행 결과(M2 백로그 수정 반영 후 재실행, 전체 인용, 41건 전부 통과 — 이전 38건에서 `judgeApproveEndToEnd`가 5→8건으로 확장되어 41건):

```
✔ judgeApproveEndToEnd: docs 증가, cluster_slug·fit 존재, origin이 /docs에 실재하면 PASS (0.0811ms)
✔ judgeApproveEndToEnd: docs가 증가하지 않으면 FAIL (0.0382ms)
✔ judgeApproveEndToEnd: docs가 감소해도 FAIL(증가만 PASS 조건) (0.0297ms)
✔ judgeApproveEndToEnd: approvedEntry 없으면 FAIL (0.0287ms)
✔ judgeApproveEndToEnd: cluster_slug가 null이면 FAIL (0.0255ms)
✔ judgeApproveEndToEnd: fit이 숫자가 아니면 FAIL (0.0272ms)
✔ judgeApproveEndToEnd: origin이 core /docs 목록에 실재하지 않으면 FAIL(신규 증거 채널) (0.0282ms)
✔ judgeApproveEndToEnd: docsAfterList가 비어있으면 origin 실재 확인도 FAIL (0.0264ms)
ℹ tests 41
ℹ suites 0
ℹ pass 41
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 423.6136
```

(그 외 33건은 다른 10개 함수군 — `extractJsonBlob`·`citesOrigin`·`judgeAskUncited/Cited`·`judgeUnindexedProof`·`judgeJournalHasIngestAndAssign`·`judgeReject`·`judgeIngestTriple`·`judgeDocsUnchanged`·`judgeManualImmediate` — 로, M2 백로그 수정과 무관하게 전부 통과해 회귀 없음을 확인.)

- 실 서버(core:8801, mind:8800) E2E 실행은 지시에 따라 수행하지 않음(실 서버 기동·E2E 측정은 관리자/team-lead 레인 담당). `eval_deep.mjs`는 두 서버 기동 후 `node eval_deep.mjs`로 즉시 실행 가능하도록 완성되어 있으며, 실행 시 `tools/eval/report_deep.json`에 기준1~3·부정 게이트 결과와 클러스터 매핑 근사치·경고가 함께 기록된다.

## 블로커

- 없음(내 담당 범위인 `tools/eval/questions_deep.json`, `tools/eval_deep.mjs`, `tools/eval/judge_deep.mjs`+자가테스트, 그리고 M2 백로그 수정 3파일은 전부 완료·문법검증·단위테스트 통과). 실제 M3 게이트 측정(기준1 ≥4/5·기준2 ≥3/5·기준3 5/5·부정 1/1)은 core/mind 서버가 M3 deep 모드(`/ask{mode:"deep"}`)까지 구현·기동된 뒤에야 가능하며, 이는 admin/team-lead 레인의 책임이다.

## M3 수정 라운드 2

M3 게이트 2차 실측(관리자 진단)에서 발견된 클러스터 매핑 근사 부정확·에러 본문 소실 결함 수정. 스코프: `tools/eval_deep.mjs`·`tools/eval/judge_deep.mjs`(judge_deep 계열)만 수정, `core/`·`contract/`·다른 eval 파일 무수정. 정본은 CONTRACT.md "## 서버 소켓·진단 규격"(코어 확장 부분) — core가 `GET /docs`에 `cluster_slug`를 노출하도록 확장된 것을 전제로 구현.

### 실측 증상

1. 기존 `buildOriginClusterMap`이 `POST /search` 스코프 쿼리 + `GET /journal` assign 이벤트 폴백으로 origin→cluster를 **근사**했는데, 질의어와 무관한 저순위 문서가 top-k 밖으로 밀려 매핑에서 누락되는 사례가 실측에서 확인됨(기준1 클러스터 다양성 판정의 정확도 저하 원인).
2. `askOne()`이 비-2xx 응답을 `res.status`만으로 에러 메시지를 구성해(`/ask(deep) 500`), 서버가 왜 실패했는지 본문 정보가 하네스 로그에서 완전히 소실 — qd01 500 원인을 하네스 출력만으로 진단 불가능했음.

### 구현 산출물

| 파일 | 변경 |
|---|---|
| `eval_deep.mjs` | `buildOriginClusterMap()`을 근사(1순위 `/search` 스코프 쿼리 + 2순위 `/journal` assign 폴백)에서 **`core GET /docs` 직독**으로 전면 교체(파라미터 없는 함수로 변경). `docs[]`를 순회해 `doc.cluster_slug`가 있는 문서만 `map[doc.origin] = doc.cluster_slug`로 채운다(근사 없음, `cluster_slug`가 `null`인 문서만 제외). 실패 시 던지지 않고 `warnings`에 누적(게이트 전체를 막지 않음). 이제 불필요해진 `searchClusterOrigins()`·`fetchJournalAssignEvents()`·`CLUSTER_SEARCH_TIMEOUT_MS` 상수를 제거했다(~50줄 삭제). 헤더 주석과 `ORIGIN_CLUSTER_MAP_METHOD` 상수를 `"GET /docs cluster_slug 직독(근사 없음, cluster_slug가 null인 문서는 맵에서 제외)."`로 갱신. `askOne()`의 비-2xx 분기가 `res.text()`로 응답 본문을 읽어 `` `/ask(${mode}) ${res.status}: ${bodyText.slice(0, 300)}` `` 형태로 에러 메시지에 포함하도록 변경(최대 300자). |
| `eval/judge_deep.mjs` | 헤더 주석만 갱신(로직·함수 시그니처 무변경) — 클러스터 매핑이 이제 근사가 아니라 core `GET /docs`의 `cluster_slug` 직독 결과임을 반영. `originsOf`/`clustersOfSources`/`judgeMultiClusterCitation`/`judgeNewSourceRecovery`/`judgeTraceCompleteness`/`judgeNegativeInsufficient` 6개 함수는 이미 완성된 맵을 입력으로만 받으므로 무수정. |

### 검증

- `node --check eval_deep.mjs` — 통과(문법 오류 없음).
- `node --check eval/judge_deep.mjs` — 통과.

```
$ node --check eval_deep.mjs && node --check eval/judge_deep.mjs
SYNTAX_OK
```

- `node --test eval/judge_deep.test.mjs` 재실행 결과(함수 로직 무변경이므로 15건 전부 그대로 통과, 회귀 0건), 전체 인용:

```
✔ originsOf: sources[]에서 origin만 순서대로 추출 (1.3996ms)
✔ clustersOfSources: 매핑에 있는 origin만 클러스터 슬러그로 모음(미매핑은 무시) (0.1153ms)
✔ judgeMultiClusterCitation: 서로 다른 클러스터 2개 인용 시 PASS (0.106ms)
✔ judgeMultiClusterCitation: 클러스터 1개만 인용 시 FAIL (0.1162ms)
✔ judgeMultiClusterCitation: 맵에 전혀 매핑되지 않으면 0개로 FAIL (0.0685ms)
✔ judgeNewSourceRecovery: deep이 fast에 없던 origin을 회수하면 PASS (0.0881ms)
✔ judgeNewSourceRecovery: deep 출처가 fast의 부분집합이면 FAIL (0.0616ms)
✔ judgeNewSourceRecovery: 신규 출처 중복은 한 번만 집계 (0.0819ms)
✔ judgeTraceCompleteness: 전 active 클러스터가 consulted/skipped로 정상 등장하면 PASS (0.1405ms)
✔ judgeTraceCompleteness: 클러스터가 trace에서 통째로 빠지면 FAIL (0.1129ms)
✔ judgeTraceCompleteness: consulted인데 subquestion이 빈 문자열이면 FAIL (0.0809ms)
✔ judgeTraceCompleteness: skipped인데 why가 없으면 FAIL (0.0725ms)
✔ judgeNegativeInsufficient: insufficient === true면 PASS (0.0733ms)
✔ judgeNegativeInsufficient: insufficient === false면 FAIL (0.039ms)
✔ judgeNegativeInsufficient: insufficient 필드 자체가 없으면 FAIL (0.0289ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 288.7863
```

### 편차 / 설계 결정 기록

- **매핑 실패 시 예외를 던지지 않고 warnings 누적**: 기존 근사 방식과 동일한 에러 내성 정책을 유지했다 — `GET /docs` 호출이 실패해도 `buildOriginClusterMap()`은 빈 맵 + warning 문자열을 반환할 뿐 던지지 않는다. 이는 팀리드 스펙에 명시되지 않았으나, 기존 `main()`의 "게이트 전체를 막지 않는다"는 설계 원칙을 그대로 계승한 것이며 스펙과 상충하지 않는다고 판단했다.
- **에러 본문 300자 절단**: 팀리드 스펙 "본문 300자"를 그대로 `bodyText.slice(0, 300)`으로 구현. 서버가 매우 긴 스택 트레이스를 500 본문에 실어 보내는 경우에도 하네스 콘솔/리포트가 과도하게 비대해지지 않도록 하는 안전장치로, 스펙이 명시한 값이라 임의 변경 없이 그대로 따랐다.
- **자가 검토로 발견·수정한 버그**: 최초 편집 라운드 직후 전체 파일을 재확인하는 과정에서 두 가지 잔여 결함을 스스로 발견했다 — (1) `main()`의 호출부가 시그니처 변경(`buildOriginClusterMap(clusters)` → 무인자) 후에도 여전히 `clusters` 인자를 넘기고 있었음, (2) 경고 로그 문구가 `"origin->cluster 근사 맵 경고:"`로 남아 "근사"라는 이제는 사실이 아닌 표현을 담고 있었음. 둘 다 이번 라운드 내 자체 재검토로 발견·수정했으며(외부 지적이나 테스트 실패로 드러난 것이 아님), 최종 산출물에는 반영 완료 상태로 남아 블로커가 아니다.

### 블로커

없음. 지시된 2개 파일 수정(`eval_deep.mjs`/`eval/judge_deep.mjs`) 전부 완료·검증되었다(judge_deep 테스트 15건 회귀 없음). `GET /docs`의 `cluster_slug` 직독이 core의 실제 M3 확장 구현과 맞물려 정확한 매핑을 산출하는지의 실 서버 E2E 재확인(core가 청크 `cluster_ids` 기준 배정을 실제로 `GET /docs` 응답에 반영하는지)은 core 담당 레인의 작업 완료 후 관리자/team-lead가 실 서버로 재측정할 사안이라 이번 라운드에서는 수행하지 않았다.

## M3 수정 라운드 3

M3 게이트 3차 실측(관리자 진단)에서 발견된 클라이언트측 헤더 타임아웃 결함 수정. 스코프: `tools/eval_deep.mjs`만 수정, `core/`·`contract/`·다른 eval 파일 무수정. 정본은 CONTRACT.md "## LLM 타임아웃 규격" 절의 3차 실측 개정 항목(mind와 공유) — 그대로 구현. 관련 배경·mind 측 수정(`llm.ts` sonnet 타임아웃 상향, `deep.ts` 클러스터 에이전트 동시성 2 제한 풀)은 `mind/RESULTS.md`의 동명 절 참고.

### 실측 증상

1. Node `fetch`(undici)가 자체 `headersTimeout`(기본 300s)을 갖고 있어, `/ask` 호출이 서버 쪽에서는 정상 처리 중이어도 5분을 넘기면 **클라이언트(하네스)** 쪽에서 먼저 소켓을 끊는다 — qd01/qd04의 "fetch failed" 실패와 qd03(272s, 통과)·qd05(306s, 경계에서 통과) 실측치가 이 가설과 정합. 서버측 `requestTimeout=0`(라운드 2에서 이미 적용) 설정과 무관하게 발생하는, 순전히 하네스 전송 계층의 결함이었다.

### 구현 산출물

| 파일 | 변경 |
|---|---|
| `eval_deep.mjs` | `/ask` 호출부(`askOne()`)를 `fetch`에서 `node:http`(로컬 서버 대상) `request()` 직접 구현으로 교체. POST JSON(UTF-8)을 `Content-Length` 헤더와 함께 직접 작성하고, 응답 청크를 수집해 UTF-8로 조립한다. 자체 타임아웃은 `mode`에 따라 fast 300_000ms · deep 1_200_000ms으로 `req.setTimeout(timeoutMs, ...)`에 등록하고, 콜백에서 `req.destroy()` + `settled` 불리언 가드로 이중 resolve/reject를 방지(`mind/src/llm.ts`의 `ClaudeCliLlmClient`와 동일 패턴). 타임아웃 시 기존 "하네스 타임아웃(...)" 에러 메시지 포맷을 그대로 유지(동적 초 단위 계산 로직 무변경, 라운드 1에서 확정한 `Math.round(timeoutMs / 1000)` 방식 재사용). 비-2xx 응답은 라운드 2에서 도입한 본문 300자 포함 에러 메시지(`` `/ask(${mode}) ${res.status}: ${bodyText.slice(0, 300)}` ``) 그대로 재현. `/health`·`GET /docs` 등 짧은 호출은 `fetch` 그대로 둠(헤더 타임아웃 300s 내에 항상 완료되는 호출이라 전환 불필요). |

### 검증

- `node --check eval_deep.mjs` — 통과(문법 오류 없음).

```
$ node --check eval_deep.mjs
(출력 없음, 종료 코드 0)
```

- 이번 라운드는 `askOne()`의 전송 계층(HTTP 클라이언트 구현)만 교체했고 `eval/judge_deep.mjs`는 무수정이므로, judge_deep 자가테스트 15건은 재실행 대상이 아니다(로직 변경 없음). mind 쪽 신규/갱신 유닛 테스트(63건, sonnet 타임아웃·동시성 풀 포함)는 `mind/RESULTS.md`의 "M3 수정 라운드 3" 절에 별도 기록.

### 편차 / 설계 결정 기록

- **`node:http`만 사용, `node:https` 미사용**: `/ask` 대상은 항상 로컬 mind 서버(`http://localhost:PORT`)이므로 `node:https`는 불필요해 도입하지 않았다 — CONTRACT.md M1 "런타임 의존성 0(node:http·child_process·global fetch)" 제약과도 정합.
- **하네스 타임아웃 에러 메시지·비-2xx 처리 포맷 무변경**: 팀리드 지시문이 두 동작 모두 "유지" 요구 — 라운드 1에서 확정한 동적 초 단위 계산과 라운드 2에서 확정한 300자 절단 로직을 그대로 재사용해 전송 계층 교체가 사용자 관측 가능한 에러 메시지 포맷에 영향을 주지 않도록 했다.
- **`/health`·`GET /docs`는 `fetch` 유지**: 팀리드 지시문이 "짧은 호출은 fetch 유지 가능"이라 명시했고, 이 호출들은 응답이 항상 수 초 내로 끝나 undici의 300s `headersTimeout`에 걸릴 여지가 없어 전환 실익이 없다고 판단했다.

### 블로커

없음. 지시된 1개 파일 수정(`eval_deep.mjs`)이 완료·검증되었다(`node --check` 통과, judge_deep 15건은 무영향 확인). 실 서버 대상 장시간(300s+) deep 호출로 소켓 절단이 실제로 해소되는지의 E2E 재확인은 이번 태스크 스펙이 명시적으로 관리자/team-lead 담당으로 규정했으므로 수행하지 않았다.
