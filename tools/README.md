# tools

- `node collect_seed.mjs` — 위키(`~/.claude/wiki`)와 메모리(`~/.claude/projects/D--/memory`)에서 시드 코퍼스를 `D:\cosmos\data\seed\{wiki,memory}\` + `manifest.json`으로 수집한다.
- `node eval_search.mjs` — cosmos-core(`http://127.0.0.1:8801`)가 기동된 상태에서 `eval/questions.json` 12문항을 검색해 hit@6을 측정하고 `eval/report.json`을 기록한다. core 미기동 시 즉시 종료.
- 평가셋은 `eval/questions.json`에 있으며 각 문항은 위키 페이지 1개당 1문항, `gold_files`는 origin 절대경로의 베어 파일명 규약을 따른다.
- `node eval_ask.mjs` — mind(`http://127.0.0.1:8800`, env `COSMOS_MIND_URL`로 override 가능)가 기동된 상태에서 `eval/questions_ask.json`(긍정 10 + 부정 3, 총 13문항)으로 `/ask`를 호출해 정답 인용·불충분 판정·trace 유효성(consulted/skipped/why)을 측정하고 `eval/report_ask.json`을 기록한다. mind 미기동 시 즉시 종료. 게이트: 긍정 ≥ 8/10, 부정 = 3/3, trace_ok 전건(CONTRACT.md M1 게이트 §2~4).
- `eval_ask.mjs`의 판정 로직은 `eval/judge_ask.mjs`(순수 함수)로 분리되어 있으며 `node --test eval/judge_ask.test.mjs`로 정답/오답/trace 결여 등 픽스처 기반 자가검증이 가능하다.
