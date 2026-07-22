# M4 — 3D 우주 뷰 프론트 검증 결과 (`mind/web/`)

담당: designer (task #33). 범위: `D:\cosmos\mind\web\` 전용. `mind/src`, `core/`, `contract/`는 무접촉.

## 산출물

```
mind/web/
  index.html            정적 진입점. importmap으로 "three" → /web/vendor/three.module.min.js
  app.js                부트스트랩: /universe(또는 ?fixture=1 시 dev-fixture.json) fetch → scene/interactions/ask 배선
  style.css              다크 스페이스 테마, 패널/레전드/툴팁/질문박스 전체 스타일
  scene.js               three.js 씬: 성운 구체·와이어프레임·글로우 스프라이트·Points 문서 파티클(+비가시 히트 프록시)·엣지 커브·궤적 애니메이션 프리미티브
  interactions.js        레이캐스팅(호버 툴팁 + 클릭), OrbitControls 배선
  utils.js               결정론 해시, 색상 매핑(source_type), 소형 헬퍼
  ask.js                 질문박스 제출 → POST /ask → 궤적 재생 → 답변/출처/궤적 패널 렌더
  dev-fixture.json       5클러스터/30문서 가짜 /universe + 내장 fixture ask 응답(정상/insufficient 두 케이스)
  vendor/
    three.module.min.js  365,552 bytes
    three.core.min.js    385,390 bytes
    OrbitControls.js      40,504 bytes
    CSS2DRenderer.js       7,384 bytes
```

## 검증 1 — 외부 요청 0 (CDN 금지) 실측

`grep -rn 'https?://|cdn\.|jsdelivr|unpkg|googleapis|gstatic' mind/web --include=*.{html,js,css}` 결과 3건, 전부 무해:

1. `app.js:34` — 문자열 리터럴 `"http://localhost:8800"`은 `file://`로 직접 열었을 때 사용자에게 보여줄 한국어 안내 메시지 안의 예시 텍스트(실제 fetch 아님).
2. `vendor/three.module.min.js:6` — three.js 자체 셰이더 코드 주석 안의 논문 인용(`https://jcgt.org/published/0007/04/01/`), 네트워크 요청 아님.
3. `vendor/three.core.min.js:6` — `http://www.w3.org/1999/xhtml`, three.js 내부 XHTML 네임스페이스 상수 문자열(SVG/DOM 관련 코드에서 관용적으로 쓰이는 식별자), 네트워크 요청 아님.

authored 코드(`index.html`/`app.js`/`style.css`/`scene.js`/`interactions.js`/`utils.js`/`ask.js`) 안에는 외부 URL 문자열이 전무함. 폰트는 `style.css`에 시스템 폰트 스택만 사용(`@font-face`/`@import` 없음). `<link>`·`<script src="http...">` 없음.

## 검증 2 — 벤더링 실재 + import 경로

- `vendor/` 4개 파일 실재, 바이트 수 위 표와 일치. `three@0.185.0`(r0.185.1) npm pack 결과와 바이트 단위 동일 확인(버전 불일치 위험 0).
- **발견 및 수정한 결함**: 최초 벤더링 시 `three.core.min.js`(three.module.min.js가 내부적으로 import하는 코어 모듈)가 누락되어 있었음 — 정적 서버로 열면 브라우저 콘솔에 모듈 로드 실패가 났을 상황. `npm pack three@0.185.0`에서 재추출해 추가, 바이트 비교로 정합성 확인 후 커밋.
- `index.html`의 `<script type="importmap">`: `"three"` → `/web/vendor/three.module.min.js` (절대경로). JS-to-JS import(`scene.js`의 OrbitControls/CSS2DRenderer 등)는 전부 상대경로 specifier.

## 검증 3 — ES 모듈 구문 검증

```
node -e "import('file:///D:/cosmos/mind/web/app.js').catch(e=>{console.error(e.message);process.exit(1)})"
```
DOM 부재로 인한 런타임 실패(`document is not defined` 계열)는 예상된 정상 결과. **SyntaxError 없음** — 구문 정합 확인.

## 검증 4 — 픽스처 모드 자가 렌더 검증 (헤드리스 스크린샷)

`index.html?fixture=1`을 추가해 `dev-fixture.json`(5클러스터·30문서, `/ask` 픽스처 응답 2종: 정상 답변 + insufficient)을 실 서버 없이도 로드하도록 배선. Playwright(Chromium, viewport 1600x1000 — headless min-window-width 아티팩트 회피)로 `D:/cosmos/mind`를 루트로 하는 임시 정적 서버(포트 8899, `/web/...` 절대경로가 실제 배포와 동일하게 해석되도록) 위에서 검증. 검증 종료 후 임시 서버 프로세스 종료 완료(scratch 전용, 배포물 아님).

측정 결과(최종 스크립트, 스테일 마커 버그 수정 후):

| 시나리오 | 결과 |
|---|---|
| 초기 로드: 로딩 오버레이 해제, 에러 오버레이 숨김, 레전드 "클러스터 5개 · 문서 30개" | 통과 |
| 클러스터 클릭 → 우측 패널(이름/설명/문서수·청크수/status/대표문서 6건) | 통과 (스크린샷 확인) |
| 질문 제출(정상 케이스) → 궤적 애니메이션 재생 → 답변 패널(문장별 `[n]` 인용 3개, 출처 3건, 궤적 5클러스터 consulted/skipped 표시, 비용 푸터) | 통과, `SOURCE_ITEM_COUNT: 3`, `PAGE_ERRORS: []` (스크린샷 확인) |
| 출처 클릭 → 카메라가 해당 문서 파티클로 포커스 + 하이라이트 링 | 통과 (스크린샷 확인) |
| insufficient 매직 문구("코퍼스 밖에 있는 질문입니다") → 씬 채도/명암 감소(`insufficient-flash` 클래스) + "이 우주 안에서는 근거를 찾지 못했습니다" 배너 + 전 클러스터 skipped 표시 + `LLM 호출 0회` | 통과, `INSUFFICIENT_FLASH_CLASS_PRESENT: true` (스크린샷 확인) |
| 정상 답변 중에는 `insufficient-flash` 미부착 | 통과, `FLASH_DURING_NORMAL_ANSWER: false` |
| 패널 닫기 → `insufficient-flash` 해제 | 통과, `FLASH_AFTER_PANEL_CLOSE: false` |
| 콘솔 에러 | 0건 (경고만: three.js Clock deprecation, headless GPU ReadPixels stall — 둘 다 무해) |

**테스트 방법론 결함(자체 발견·수정, 앱 결함 아님)**: 첫 버전 스크립트는 `renderAnswer()`가 정상/insufficient 두 분기 모두에서 "궤적" 텍스트를 쓴다는 점을 놓쳐, 직전 정상-답변 렌더의 스테일 텍스트를 "새 렌더 완료" 신호로 오판했다. insufficient 픽스처는 `consulted` 항목이 0건이라 `playTrajectory()`의 유일한 await 루프가 실행되지 않아 전체 파이프라인이 1초 이내로 끝나는데, 이 타이밍에서 스테일 마커가 즉시 매치되어 `insufficient-flash` 클래스 부착 이전에 평가되는 false negative가 발생했다. `#panel-title` 텍스트가 현재 질문 문자열과 일치하는지로 대기 조건을 바꿔 해결(질문마다 유값이 유일하므로 신뢰 가능). 수정 후 재실행 결과가 위 표.

## 계약 편차/설계 결정 기록

- **경로 규약**: HTML 레벨 참조(`<script src>`, importmap, `fetch('/universe')`, `fetch('/ask')`, `fetch('/web/dev-fixture.json')`)는 전부 절대경로 `/web/...` 또는 API 루트(`/universe`, `/ask`)를 사용. mind 정적 서버가 `GET / → web/index.html`이고 `/web/*`를 정적 서빙한다는 계약(§ M4 "3D 웹 뷰")을 그대로 전제. **다른 레인(mind 서버)이 이 절대경로 규약을 지켜야 프론트가 그대로 동작함** — 정적 서버 루트가 `mind/` 디렉터리(= `web/`의 부모)여야 함.
- **질문 궤적 애니메이션의 사용자 데모 검토**: CONTRACT.md M4 게이트 #5는 "질문 궤적 애니메이션은 사용자 검토 몫"으로 명시. 본 문서의 헤드리스 검증은 DOM 상태·CSS 클래스·스크린샷 정합까지만 자가 확인했고, 실제 라이브 서버(`/universe`+`/ask` 실동작) 대상 데모는 게이트 단계에서 사용자가 별도 확인해야 함.
- **fixture 모드**: `?fixture=1` 쿼리로 `dev-fixture.json`을 로드하고, 질문에 "코퍼스 밖"을 포함하면 insufficient 응답을 픽스처가 시뮬레이션하도록 구현(콘솔에 안내 로그 출력). 개발/데모/회귀 스크린샷 용도로 유지 — 실 서버 연동과 무관, 배포 시 제거할 필요 없음(쿼리 파라미터 미지정 시 완전히 무시됨).
- **file:// 직접 열람 처리**: fetch 실패 시 한국어 안내 메시지("file://로 직접 연 페이지에서는 우주 데이터를 불러올 수 없습니다. mind 서버를 통해 접속해 주세요.")를 에러 오버레이에 표시. 콘솔 에러로 죽지 않고 UI로 안내.

## 미해결/다음 레인 의존

- 실제 `/universe`·`/ask` 엔드포인트(mind 서버, task #32)가 살아있는 상태에서의 종단 렌더는 아직 본 검증 범위 밖(fixture로만 자가 검증). task #32가 완료 처리되었으므로, 게이트 #34 단계에서 실 서버 기동 후 정적 서빙 경로(`/`, `/web/*`)와 `/universe` 응답 스키마 정합을 본체가 재확인 필요.

## 폴리시 라운드(성운)

담당: designer. 범위 동일(`mind/web/` 전용, `mind/src`·`core/`·`contract/` 무접촉). 요청 2건: (1) 클러스터 시각을 "풍선"(반투명 정이십면체 + 와이어프레임 셸)에서 실제 성운/가스구름으로 교체, (2) 질문 입력창 placeholder를 "우주에게 질문하기…" → "질문하기"로 축약.

### 변경 파일

- `scene.js` — 성운 셰이더 시스템 추가, 히트-피킹을 프록시 구체로 분리, 기존 애니메이션 API(`spawnPulse`/`flashCluster`/`setClusterDim`/`pulseBeacon`) 재배선. **문서 파티클 검정 렌더링 결함 발견 및 수정**(아래 별도 절).
- `utils.js` — 결정론 시드 난수 유틸 추가(`hashSeed`, `mulberry32`, `seededRandom`).
- `index.html` — placeholder 텍스트 수정.

### 성운 구현

- `THREE.Points` + 커스텀 `ShaderMaterial`(`buildNebulaCloud`)로 클러스터당 26~46개 입자(반경 비례, `count = clamp(18 + radius*1.8, 26, 46)`) 생성. 코어 22%는 중심 밀집(`radius * spread * rand^1.5`)·소형·고휘도, 나머지는 반경 전체에 분산·대형·저휘도 — 중심 고밀도→외곽 불규칙 페이드아웃 형태.
- 배치는 `seededRandom(seedKey)`(mulberry32, 문자열 해시 시드) 전용 — `Math.random()` 미사용, 클러스터별로 항상 동일한 형태 재현.
- 프래그먼트 셰이더에서 `atan`/`sin` 각도 섭동으로 원형이 아닌 블롭 형태 절차적 셰이딩(텍스처 자산 없음). `AdditiveBlending` + `depthWrite:false` + `vertexColors:true`로 가산혼합 가스 느낌.
- `uDim`/`uBoost`/`uBreath` uniform을 애니메이션 표면으로 노출 — 기존 `setClusterDim`/`flashCluster`/breathing 루프가 셰이더 uniform을 직접 갱신하도록 재배선(공개 API 시그니처 불변).
- **히트 피킹**: `buildClusterHitProxy(c)` — 보이지 않는(`MeshBasicMaterial({visible:false})`) 구체를 성운과 별개로 두어 레이캐스트 타겟으로 사용. `material.visible=false`는 렌더 리스트에서 제외되지만 `Raycaster.intersectObjects`는 `.visible`을 검사하지 않으므로 클릭/호버는 그대로 동작.
- 라벨 스프라이트·엣지 커브·범례·문서 파티클·궤적 애니메이션은 무변경(계약 유지).

### 문서 파티클 검정 렌더링 결함 (발견·근본원인·수정)

성운 교체 후 자가 스크린샷 검증 중 `docMesh`(문서 InstancedMesh) 입자가 줌 레벨에 무관하게 불투명한 검정 원으로 렌더링되는 것을 발견. 기존 프리-존재 코드(`docMesh`/`haloMesh` 생성부, 이번 성운 작업으로 새로 건드리지 않은 영역)의 잠재 결함으로, 원인 규명에 다단계 격리 테스트(Playwright + three.js 씬 그래프 직접 조작 — 인스턴스별/전체 리컬러, geometry 격리, frustum/바운딩스피어/행렬 검증, 셰이더 소스 직접 추출)를 거쳤다.

**근본 원인**: `docGeom`/`haloGeom`(둘 다 `IcosahedronGeometry`)에 per-vertex `color` 어트리뷰트가 없는 상태로, `docMat`/`haloMat`이 `vertexColors:true` + `InstancedMesh.setColorAt()`(`instanceColor`)를 동시에 사용하고 있었다. 벤더링된 three.js(r185) 소스를 직접 추출해 확인한 결과, `USE_COLOR` 셰이더 define은 `material.vertexColors` 단독이 아니라 `instanceColor` 존재 여부와도 OR로 묶여 있어(`vertexColors || instancingColor`), 정점 셰이더의 `color_vertex` 청크가 다음 순서로 실행된다:

```glsl
vColor = vec4(1.0);
vColor.rgb *= color;          // geometry.attributes.color — 없으면 WebGL 미바인딩 attribute 기본값 (0,0,0)
vColor.rgb *= instanceColor.rgb;  // 이미 0이므로 무의미
```

지오메트리에 `color` 어트리뷰트가 없으면 WebGL이 바인딩되지 않은 제네릭 attribute에 기본값 `(0,0,0,1)`을 대입하므로, `instanceColor`가 무엇이든 곱셈 체인이 그 전에 이미 0으로 죽어 프래그먼트에서 `diffuseColor *= vColor`가 항상 검정이 된다. `instanceColor` 버퍼 자체(30개 문서 전수 검사, `source_type`→`SOURCE_COLORS` 매핑 포함)는 완전히 정상이었음을 확인했고 — 즉 버그는 색상 계산 로직이 아니라 순수 three.js InstancedMesh + vertexColors 조합의 gotcha였다.

**수정**: `docGeom`/`haloGeom` 생성 직후 흰색(1,1,1) no-op `color` 어트리뷰트를 명시적으로 채우는 `whiteVertexColor()` 헬퍼 추가(`scene.js`). 정점 곱셈이 항등연산이 되어 `instanceColor`가 그대로 통과하도록 함. `haloMesh`도 동일 결함(가산혼합 검정=무효과라 시각적으로 눈에 덜 띄었을 뿐 동일하게 깨져 있었음)이라 함께 수정.

**검증(수정 전/후)**: 격리 테스트에서 `docGeom`에 흰색 `color` 어트리뷰트를 임시 주입한 결과만으로 원본 미변경 `docMat`이 즉시 정상 렌더로 전환됨을 확인(`whiteVertexColor` 수정과 동일 메커니즘) → 그대로 소스에 반영. 수정 후 `?fixture=1` 전체 재검증(아래) 스크린샷에서 5개 클러스터 전부 정상 색상(session=teal, arxiv=purple, rss=orange, manual=off-white) 문서 파티클 확인, 검정 블롭 완전 소거.

### 재검증 결과 (수정 반영 후)

| 항목 | 결과 |
|---|---|
| `node -e "import('./scene.js')"` / `utils.js` | SyntaxError 없음 (three 패키지 미해결 오류만, 예상된 정상) |
| 초기 로드(`?fixture=1`): 레전드 "클러스터 5개 · 문서 30개" | 통과 |
| placeholder 텍스트 | `"질문하기"` 확인 |
| 일반 줌 스크린샷 | 5개 성운 전부 중심 고밀도→외곽 불규칙 페이드, 구체 아님. 문서 파티클 색상 정상, 라벨 가독 유지 |
| 근접 줌(휠 14틱) 스크린샷 | 성운 블롭 텍스처 유지, 문서 입자(정이십면체+헤일로) 정상 색상, 라벨 겹침 없음 |
| 클러스터 직접 클릭 → 우측 패널 오픈 | 통과(`PANEL_OPEN_ON_CLUSTER_CLICK: true`, 타이틀 "LLM 에이전트 파이프라인" 확인) |
| 콘솔 에러 | 0건 (three.js Clock deprecation + headless GPU ReadPixels stall 경고만, 기존과 동일 무해) |
| 외부 네트워크 요청 | 정적 grep(authored 파일 전수) 0건 + 런타임 캡처(전체 12건 요청, 전부 `localhost:8899`) 0건 — 실측 이중 확인 |

**테스트 방법론 노트**: `verify.js`의 기존 3번째 시나리오(캔버스 중앙 클릭 → 패널 오픈 기대)가 이번 라운드에서 `false`로 관측됐으나, 14회 휠 줌 후 캔버스 중앙 좌표가 클러스터가 아닌 빈 우주 공간(베이컨 근처)에 위치하는 좌표 계산 문제로, 클러스터 좌표를 직접 겨냥한 별도 클릭 테스트로 정상 동작 재확인함(위 표). 앱 결함 아님, 기존 스크립트의 줌-후 좌표 가정 오류.

### 성능/스코프

- 클러스터 5개 × 최대 46입자 = 최대 230 스프라이트(계약 목표 "~10클러스터×40입자=400" 이내). `renderer.info.render.triangles` 정상 범위 확인(격리 테스트 중 실측).
- 임시 디버그 스캐폴딩(`_debug_harness.html`, `window.__sceneApi` 노출 하네스)은 검증 완료 후 삭제 완료 — 배포물에 남아있지 않음.

## 폴리시 라운드 2 — 문서 파티클 점광원화 + 클릭 우선순위 결함 수정

담당: designer. 범위 동일(`mind/web/` 전용). 요청: "각 파티클이 구가 아니라 점으로 해줘" — 문서 파티클이 3D 입체 구슬로 읽혀 별처럼 보이는 점 광원으로 교체.

### 변경 (`scene.js`)

- `docMesh`/`haloMesh`(InstancedMesh+IcosahedronGeometry 구체, `whiteVertexColor` no-op 색 포함) 전체 제거 → `docPoints`(`THREE.Points` + 커스텀 `ShaderMaterial`)로 교체. 정점 셰이더는 성운과 동일한 `aSize * (260/-mvPosition.z)` 원근 감쇠 패턴, 프래그먼트는 성운의 각도 굴곡(blob wobble) 없이 단단한 원형 코어 + 짧은 가장자리 페이드(`smoothstep(0.5,0.35,d)`)만 사용 — 낱개 점/별로 읽히고 성운과 시각적으로 구분되도록 의도적으로 다르게 설계.
- 색상은 `BufferGeometry`의 실제 per-vertex `color` 어트리뷰트에 `source_type`별 색을 직접 채움 — `InstancedMesh.setColorAt`/`instanceColor` 경로를 전혀 쓰지 않으므로 이전 라운드의 InstancedMesh+vertexColors 검정 렌더링 결함 클래스가 구조적으로 재발 불가.
- 클릭/호버 판정은 `docPoints`(`raycast = () => {}`로 피킹 제외)와 분리된 별도 비가시 `docHitProxy`(`InstancedMesh` of small spheres, `MeshBasicMaterial({visible:false})`)가 전담 — 클러스터 히트 프록시와 동일한 검증된 패턴 재사용. `Points`의 `Raycaster.params.Points.threshold`는 월드 단위라 줌 레벨마다 판정 크기가 달라져 불안정하므로 채택하지 않음.

### 발견·수정한 결함: 클러스터 프록시가 문서 클릭을 항상 가림

검증 중 문서 30개 전수가 예외 없이 자신이 속한 클러스터의 히트 프록시 구(반경 `c.radius*0.85`) **안쪽**에 위치함을 실측 확인(`dev-fixture.json` 좌표 계산). 레이가 구 내부의 한 점(문서)에 닿으려면 반드시 그 전에 구 표면을 먼저 통과해야 하므로, 기존의 "레이 상 최근접 히트" 단순 우선순위(`hits[0]`)로는 **문서를 직접 클릭하는 것이 기하학적으로 항상 불가능**했다 — 성운을 InstancedMesh로 렌더하던 이전 라운드에도 동일한 좌표·동일한 프록시 공식이 쓰였으므로 이번 변경이 만든 회귀가 아니라 선재 결함. `raycastAtClient`에서 히트 목록 중 `docHitProxy` 히트를 우선하도록 한 줄 수정(`hits.find(h => h.object === docHitProxy) || hits[0]`)해 해결 — 문서가 없는 빈 영역 클릭 시에만 클러스터가 걸리는 동작은 그대로 유지.

### 검증

- Playwright 헤드리스(1600×1000): 클러스터 클릭 → 700ms `focusOn` 애니메이션 후 문서 파티클을 직접 클릭 → 우측 패널 `문서`/제목("LlmClient 추상화 claude-cli vs api 백엔드")/출처("세션 기록")/경로/적합도 67%/클러스터명 전부 정상 렌더, 하이라이트 링이 클릭한 문서 위치에 정확히 표시(`highlightDocByIndex`/`getDocWorldPos`/`focusOn` 정상), 카메라가 해당 문서로 포커스 — 스크린샷으로 육안 확인.
- 같은 스크린샷에서 문서 파티클이 작고 또렷한 원형 점(teal=session, purple=arxiv)으로 렌더되고 배후 성운의 불규칙 블롭 텍스처와 명확히 구분됨을 확인 — "점으로 보임" 요구 충족.
- 콘솔 에러 0건, 외부 네트워크 요청 0건(런타임 캡처).
- 전체 회귀(`verify.js`): placeholder `"질문하기"`, 레전드 `클러스터 5개 · 문서 30개` 정상, 콘솔 에러 0건 유지.

## 폴리시 라운드 3 — 성운 파티클 자체 공전(orbit)

담당: designer. 범위 동일(`mind/web/` 전용). 요청: "각 성운들 파티클이 천천히 성운 중심으로 공전하게 해줘" — 성운을 이루는 파티클 각자가 자기 클러스터 중심축 둘레를 아주 천천히 공전해 "살아있는" 느낌을 주는 것.

### 변경 (`scene.js`)

- `NEBULA_VERTEX_SHADER`에 로드리게스 회전 공식(`p*cosθ + (axis×p)*sinθ + axis*(axis·p)*(1-cosθ)`)을 추가해, 파티클별 로컬 위치를 시간에 따라 자기 궤도축(`aOrbitAxis`) 둘레로 회전시킨 뒤 `modelViewMatrix`에 넣는다. 로드리게스 회전은 항등적으로 `|p|`(원점으로부터의 거리)를 보존하므로, 이미 존재하는 성운 볼륨 포인트클라우드 생성 시의 파티클-중심 거리 자체가 별도 반경 어트리뷰트 없이 그대로 궤도 반경이 된다 — 신규 어트리뷰트를 축(`aOrbitAxis`, vec3)과 속도(`aOrbitSpeed`, float) 두 개로 최소화.
- `buildNebulaCloud()`의 기존 `seededRandom(seedKey)` 결정론 스트림에서 파생: 궤도축은 구면 균등 샘플링(`theta`/`phi`)으로 파티클마다 서로 다른 궤도 평면을 갖고, 속도는 `±(0.025~0.115) rad/s`(한 바퀴 약 40초~250초, "천천히" 요건 충족)로 부호까지 시드에서 결정. 위상 오프셋은 새 어트리뷰트를 추가하지 않고 블롭 워블용으로 이미 존재하던 `aSeed`를 재사용 — "기존 시드 결정론 값에서 파생, 랜덤 금지" 요건을 어트리뷰트 최소화로 만족.
- CPU 쪽은 `tick()`의 클러스터별 루프에 `entry.nebula.material.uniforms.uTime.value = elapsed;` 한 줄만 추가 — 실제 파티클 위치 재계산은 전부 정점 셰이더(GPU)에서 수행되므로 파티클 수와 무관하게 CPU 프레임 비용 증가가 없다.
- 기존 클러스터 단위 강체 회전(`entry.nebula.rotation.y = elapsed * entry.rotSpeed`)과 `uBreath`(맥동)/`uDim`(감광)/`uBoost`는 그대로 유지 — 오브젝트 레벨 강체 회전 위에 파티클 레벨 개별 공전을 얹는 구조라 서로 다른 계층에서 합성되어 간섭 없음.
- `docPoints`(문서 파티클)는 이번 라운드에서 의도적으로 무변경. `docHitProxy`(클릭 판정용 비가시 InstancedMesh)와 `highlightDocByIndex`/`getDocWorldPos`가 전부 빌드 시 1회 계산된 정적 좌표에 의존하므로, 문서 점에 셰이더 공전을 추가하면 시각 위치와 클릭 판정이 즉시 어긋날 위험이 있다는 가이드에 따라 문서 점은 정지 유지, 성운 파티클만 공전.
- 라벨(`CSS2DObject`)·히트 프록시(`buildClusterHitProxy`)는 클러스터 중심 고정 좌표를 그대로 사용해 무변경 — 영향 없음.

### 검증

WebGL `gl.readPixels()`를 `page.evaluate()`로 렌더 루프 밖에서 직접 호출하면(`preserveDrawingBuffer` 미설정 상태) 브라우저가 프레임 컴포지트 직후 드로잉 버퍼를 비워 레이스가 발생, 실제로는 정상 렌더 중인데도 전부 0으로 읽히는 위양성을 1차 시도에서 확인 → `page.screenshot()` PNG 버퍼를 `page.evaluate()` 내부에서 `Image`+오프스크린 `canvas`로 디코드해 `getImageData()`로 비교하는 방식으로 전환(Playwright 컴포지팅 파이프라인을 그대로 타므로 레이스 없음).

- Playwright 헤드리스(1600×1000): 클러스터 클릭 → `focusOn`(700ms) 정착 대기 → 패널 닫기 → 클러스터 중심 500×500 크롭 영역에서 t0/t0+200ms(노이즈 바닥)/t0+4000ms(테스트 구간) 3장의 스크린샷을 `getImageData` 픽셀 비교.
  - 노이즈 바닥(200ms, 트윙클·브리드만): 변화 픽셀 7.04%, 평균 델타 3.21
  - 테스트 구간(4000ms, 공전 포함): 변화 픽셀 42.29%, 평균 델타 23.71
  - 비율 **6.01배** — 배경 애니메이션 노이즈 대비 명백히 유의한 추가 움직임 확인
- 육안 대조(`orbit3-t0.png` vs `orbit3-t1.png`): 성운 외곽 블롭(붉은 불규칙 텍스처)의 실루엣이 4초 사이 눈에 띄게 변형됨. 반면 문서 파티클 마커(teal/purple 원)는 두 스크린샷에서 픽셀 단위로 동일 위치 유지 — 공전이 성운에만 적용되고 문서 점·히트 프록시는 영향받지 않았음을 시각적으로도 확인.
- 콘솔 에러 0건(`console_errors: []`).
- 회귀: 같은 두 스크린샷에 레전드 `클러스터 5개 · 문서 30개`, placeholder `"질문하기"` 정상 표시, 클러스터 클릭 시 패널 오픈→`#panel-close-btn`으로 정상 닫힘(에러 없음) 확인 — 라운드 2까지의 동작 유지.

## 폴리시 라운드 4 — 클릭 선택 표시를 회전 고리 → 2초 사인 펄스로 교체

담당: designer. 범위 동일(`mind/web/` 전용). 요청: "클릭했을때 고리가 나와서 회전이 아니라 성운 중심이 2초 간격으로 천천히 깜빡이도록" — 클릭 선택 표시(회전하는 토러스 고리)를 걷어내고, 선택된 대상 자체(성운 코어 파티클 / 문서 점)가 ~2초 주기로 은은하게 밝아졌다 어두워지는 사인 펄스로 대체.

### 변경 (`scene.js`, `interactions.js`)

- `NEBULA_VERTEX_SHADER`에 `attribute float aIsCore`(코어 파티클 여부)와 `uniform float uSelectPulse`를 추가, `vAlpha`에 `mix(1.0, uSelectPulse, aIsCore)`를 곱해 코어 파티클에만 펄스가 적용되도록 게이팅. `buildNebulaCloud()`에서 `aIsCore` 어트리뷰트를 채우고 `uSelectPulse: { value: 1 }`를 재질 uniform에 추가.
- `DOC_POINT_VERTEX_SHADER`/`FRAGMENT_SHADER`를 재작성: `attribute float aDocIndex`(문서 고유 인덱스)와 `uniform float uHighlightIndex`/`uHighlightFade`를 추가, `step(abs(aDocIndex - uHighlightIndex), 0.5)`로 셰이더 내부에서 선택된 딱 한 점만 골라 `sin(uTime * π)` 기반 2초 주기 펄스(`vGlow`)를 먹인다. `uHighlightFade`는 선택/해제 전환 자체의 급격함만 부드럽게 감싸는 별도 승수(CPU `animateValue` 트윈, 220ms 인/380ms 아웃)로, 펄스 파형과는 독립.
- 기존 회전 토러스 고리 메커니즘(`highlightRing`/`TorusGeometry`)을 전량 제거하고 `highlightCluster(slug)`/`clearClusterHighlight()`/`highlightDocByIndex(index)`/`clearDocHighlight()`로 교체. `tick()`에 `selectedClusterSlug === entry.slug`일 때만 `uSelectPulse.value = 0.6 + 0.6*sin(elapsed*π)`를 매 프레임 갱신하는 한 줄을 추가 — 선택되지 않은 클러스터는 절대 건드리지 않는다.
- 위치(`position`)는 어떤 경우에도 변경하지 않고 크기/알파만 변화시키므로, `docHitProxy`의 정적 인스턴스 행렬·`buildClusterHitProxy`의 비가시 구체와 어긋날 일이 없다.
- `interactions.js`의 `openClusterPanel`/`openDocPanel`/`closePanel`에 대칭적인 `clear*Highlight()` → `highlight*(...)` 호출 쌍을 배선(문서 선택 시 클러스터 펄스 해제, 클러스터 선택 시 문서 하이라이트 해제, 패널 닫기 시 양쪽 모두 해제).
- 신규 펄스는 `uBoost`(`flashCluster`, `ask.js` 딥모드 궤적 전용)·`uDim`/글로우 불투명도(`setClusterDim`/`restoreCluster`, 마찬가지로 `ask.js` 전용)·`uTime`-공전(라운드 3)과 완전히 독립된 승수라 세 기존 애니메이션 계층과 간섭하지 않음. `grep`으로 `setClusterDim`/`restoreCluster`/`flashCluster` 호출부가 `ask.js`에만 존재함을 재확인(클릭 선택 경로와 물리적으로 분리됨).

### 발견·수정한 버그: 실제 클릭 흐름에서 클러스터 펄스가 전혀 발동하지 않음

1차 구현 직후 `page.evaluate()`로 `highlightCluster()`를 직접 호출하면 `uSelectPulse`가 정확히 예상대로 진동했으나(0.6±0.6, 2초 주기), `interactions.js`의 실제 클릭 흐름(`onClick` → `openClusterPanel` → `sceneApi.highlightCluster(cluster.slug)`)으로는 `uSelectPulse`가 항상 `1.000`에 고정되어 전혀 움직이지 않는 비대칭을 발견(문서 하이라이트는 같은 흐름에서 정상 동작).

**근본 원인**: 라운드 4 작업의 결함이 아니라, 라운드 2에서 이미 한 번 고쳤던 "부모(클러스터) 히트 프록시 구 안에 자식(문서) 히트 프록시가 있으면 자식이 항상 이긴다"는 `raycastAtClient`의 의도된 우선순위 로직(`hits.find(h => h.object === docHitProxy) || hits[0]`)이 원인이었다. 검증에 재사용해 온 "기존 검증된" 클릭 좌표(라운드 3의 `(610, 390)`)가 실제로는 문서 히트 프록시 위에 있어, 클릭할 때마다 `openClusterPanel`이 아니라 `openDocPanel`이 호출되고 있었던 것 — 즉 클러스터 펄스 코드 자체는 처음부터 정상이었고, **검증 스크립트가 재사용한 좌표가 성운이 아니라 문서를 클릭하고 있었던 테스트 방법론 결함**이었다. `sceneApi.raycastAtClient(x,y)`로 캔버스 전역을 스캔해 문서 프록시와 겹치지 않는 순수 클러스터 좌표 `(580, 400)`(llm-agent-pipeline)를 재확인해 해결(코드 변경 없음, 검증 좌표만 교체). 이 클래스의 함정은 `~/.claude/wiki/threejs-raycaster-nested-hitproxy-shadowing.md`에 별도 기록.

### 검증

임시로 `app.js`에 `window.__debugSceneApi` 훅을 추가(`?fixture=1` 픽스처 모드에서만)해 실제 클릭 흐름으로 GPU uniform 값을 직접 읽는 방식과, 정정된 좌표로 재촬영한 시차 스크린샷 양쪽으로 확인 후 훅은 제거했다(배포 코드에 잔존하지 않음).

- **Uniform 직접 추적**(정정된 좌표 `(580,400)` 클릭 → 100ms 간격 22회 샘플, 2.2초): 패널이 `클러스터`/`LLM 에이전트 파이프라인`으로 정상 오픈 확인 후 `uSelectPulse`가 `0.003`(저점)~`1.196`(고점) 사이를 매끄럽게 진동 — `0.6 + 0.6*sin(elapsed*π)` 공식과 정확히 일치.
- **선택 해제**: `#panel-close-btn` 클릭 → 400ms 복원 트윈 후 350ms 간격 6회 샘플(2.1초) 전부 정확히 `1.000` 고정, 패널 `open` 클래스 부재 확인 — 펄스가 완전히 멈추고 정상 상태로 복원됨.
- **교차 확인**(클러스터 선택 중 문서 클릭): 클러스터 펄스가 `1.000`으로 즉시 클리어되고(`clusterPulseAfterDocOpen: 1`) 문서 하이라이트가 정상 인게이지(`uHighlightIndex: 0, uHighlightFade: 1`) — `openDocPanel`의 `clearClusterHighlight()` 배선이 의도대로 동작.
- **시차 스크린샷**(저점 vs 고점, 800ms 간격, 클러스터 중심 투영좌표 `(800,500)` 기준 160×160 타이트 크롭): 픽셀 diff 비율(4.21배)은 라운드 3의 상시 공전 파티클 노이즈에 가려 애매했으나, 스크린샷을 육안 대조한 결과 저점에서는 코어 백색 글로우가 작고 어둡고, 고점에서는 같은 코어가 뚜렷하게 더 크고 밝게 확장되는 것을 명확히 확인(`pulse-final-sel-trough.png` vs `pulse-final-sel-peak.png`) — 선택 해제 상태의 동일 간격 스크린샷 쌍(`pulse-final-desel-t0/t1.png`)은 코어 크기·밝기가 육안상 완전히 정지.
- 콘솔 에러 0건(`console_errors: []`) — 전 시나리오(선택/해제/교차확인/최종 회귀) 공통.
- **최종 회귀**(디버그 훅 제거 후 재확인): 클러스터 클릭 → 패널(`클러스터`/`LLM 에이전트 파이프라인`) 오픈, 패널 내 문서 클릭 → 문서 패널(`문서`/`fast Q&A 파이프라인 오케스트레이션 설계`) 오픈, 패널 닫기 → 정상 닫힘, 콘솔 에러 0건 — 라운드 1~3까지의 동작 전부 유지.

### 방법론 노트

라운드 3의 상시 궤도 공전(파티클 위치가 매 프레임 이동)이 화면 전체 크롭 기준 픽셀-diff 신호의 지배적 성분이 되어, 선택/해제 상태의 펄스 유무를 스크린샷 diff 비율만으로는 신뢰성 있게 구분하지 못하는 한계를 이번 라운드에서 발견했다(선택 상태 비율 4.21배 vs 해제 상태도 유사한 배경 잡음 수준). 이 한계는 GPU uniform 값을 직접 읽는 방식(임시 디버그 훅)으로 우회해 정량적으로 확정했고, 스크린샷은 육안 대조 보조 증거로만 사용했다 — 향후 라운드에서 상시 애니메이션이 존재하는 씬의 순간적 상태 변화를 검증할 때는 픽셀-diff 비율보다 uniform 직접 추적을 1차 증거로 우선할 것.

## 폴리시 라운드 5 — 피드백 4 재검증 + 문서 파티클 반투명화(피드백 5)

담당: designer. 범위 동일(`mind/web/` 전용). 요청 2건: (4) 라운드 4의 "회전 고리 제거 → 펄스 교체"가 실제로는 적용되지 않았다는 팀리드 이의 제기(근거로 `scene.js:561-577` 지목) 재검증, (5) 문서 파티클에 반투명도를 부여해 배경/다른 점이 비치고 겹칠수록 자연스럽게 밀도가 높아 보이도록.

### 피드백 4 — 재검증 결과: 이미 정상 구현되어 있었음(회귀 아님, 코드 변경 없음)

팀리드가 지목한 `scene.js:561-577`을 재조회한 결과, 해당 라인은 `spawnPulse(fromArr, toArr, colorHex, duration)` 함수 본문(현재 라인 557-590대)이었다. 이 함수는 `ask.js`의 질문-궤적 애니메이션(`playTrajectory()`)에서 쓰는, 작은 구체(`new THREE.SphereGeometry(1.7, 12, 12)`)가 두 지점 사이를 포물선(`Math.sin(Math.PI*t)*dist*0.1`로 y축 아치) 궤적을 그리며 이동하는 이펙트로, 클릭 선택 표시와는 무관한 별개 함수다. 함수명의 "Pulse"는 이 궤적 애니메이션의 은유일 뿐, 라운드 4에서 새로 만든 선택 펄스(`uSelectPulse`)와는 이름만 겹칠 뿐 다른 코드다. 라운드 4에서 실제로 제거된 것은 `highlightRing`/`TorusGeometry` 기반 회전 고리이고, 교체된 것은 `uSelectPulse`(클러스터 코어)·`uHighlightIndex`/`uHighlightFade`(문서 점) GPU uniform 기반 2초 사인 펄스다 — 이 구현은 라운드 4 시점에 이미 완료·커밋되어 있었다. 이번 라운드는 그 상태를 재확인했을 뿐 어떤 코드도 바꾸지 않았다.

재검증 방법: 라운드 4와 동일 패턴으로 `app.js`에 임시 `window.__debugSceneApi` 훅을 다시 추가해, Playwright로 실제 클릭 흐름(사용자가 겪는 것과 동일한 `onClick → openClusterPanel/openDocPanel → highlight*()` 경로)을 그대로 재현하며 uniform을 직접 추적했다. 검증 완료 후 훅은 제거(아래 "정리" 참조).

| 항목 | 결과 |
|---|---|
| ring/고리 심볼 전수 grep(`highlightRing`\|`TorusGeometry`\|`ringMesh`\|`selectionRing`, authored 5개 파일: app/ask/interactions/scene/utils.js) | 0건 |
| 클러스터 클릭(사전 스캔 확인 좌표 `(580,400)`) → 패널 오픈 | `클러스터` / "LLM 에이전트 파이프라인" 정상 |
| `uSelectPulse` 100ms 간격 24회 샘플(2.4초) | `[0.001, 1.184]` 사이 매끄러운 사인 진동 — `0.6 + 0.6·sin(elapsed·π)` 공식과 일치 |
| 선택 해제(패널 닫기) | `uSelectPulse → 1.000` 고정, 패널 닫힘 확인 |
| 문서 클릭(`getDocWorldPos`→`camera.project` 정밀 좌표) → 패널 오픈 | `문서` / "Constrained Decoding for Structured LLM Output" 정상 |
| 교차 확인(문서 선택 중 클러스터 펄스 상태) | `clusterPulseAfterDocOpen: 1` — `openDocPanel`의 `clearClusterHighlight()` 정상 발동 |
| `uHighlightFade` / `pulse`(uTime에서 독립 재계산) 100ms 간격 24회 샘플 | `fade`는 `1`에 안정, `pulse`는 `[0, 0.998]` 사이 사인 진동 — on/off 트윈(fade)과 2초 주기 파형(pulse)이 서로 독립적으로 정상 합성 |
| 문서 선택 해제 | `fade → 0`, `idx → -1`, 패널 닫힘 |
| `ask.js` 출처 인용 클릭(`.source-item` → `highlightDocByIndex`, 피드백4 메시지가 명시적으로 지목한 경로) | 출처 3건 렌더 확인 후 클릭 → `fade:1`, 패널 오픈 정상 |
| 콘솔 에러 | 0건, 전 시나리오(클러스터 선택/해제, 문서 선택/해제, ask 경로) 공통 |

스크린샷 육안 대조(트로프 vs 피크, `fb45-01/02`=클러스터, `fb45-04a/04b`=문서)로도 코어·문서 점의 밝기·크기 변화가 트로프에서는 어둡고 작게, 피크에서는 하얗게 밝고 크게 뚜렷이 구분됨을 재확인했다.

### 피드백 5 — 문서 파티클 반투명화

`scene.js`의 `DOC_POINT_FRAGMENT_SHADER`를 수정. 기존에는 가장자리 페이드 값이 그대로 최종 알파라 내부가 사실상 불투명이었다:

```glsl
// before
float alpha = smoothstep(0.5, 0.35, d);
```

```glsl
// after
float core = smoothstep(0.5, 0.35, d);
float alpha = core * mix(0.55, 1.0, vGlow);
```

- 라운드 2에서 확정한 "짧은 가장자리 페이드"(별점 실루엣 유지) 형태는 그대로 두고, 내부 채움의 불투명도만 기본값 0.55로 낮췄다 — 뒤의 성운/다른 점이 비치고, 여러 점이 겹치는 자리는 알파 합성으로 자연스럽게 밀도가 더 높아 보이도록 하는 설계.
- 라운드 4의 선택 펄스(`vGlow`)는 알파를 최대 1.0까지 끌어올리도록 배선해, 낮아진 기본 투명도에 선택 강조가 묻히지 않게 했다.
- 재질 설정(`transparent:true`/`depthWrite:false`/기본 `NormalBlending`)은 기존 점 렌더링에 이미 필요했던 값 그대로이며 이번에 새로 추가한 설정은 없다. 성운(nebula)의 `AdditiveBlending` 반투명도는 이번 요청 범위 밖이라 무변경.
- 검증: 실행 중인 라이브 페이지의 `docPoints.material.fragmentShader` 문자열을 `page.evaluate()`로 직접 읽어 신규 `mix(0.55, 1.0, vGlow)` 포함(`true`)·구 불투명 라인 부재(`false`)를 확인 — 캐시된 구 번들이 아니라 실제 반영된 셰이더가 구동 중임을 실측했다. `material.transparent:true`, `depthWrite:false`, `blending:1`(NormalBlending)도 함께 확인. 스크린샷(`fb45-00`~`fb45-05`)을 육안 대조한 결과 겹치는 문서 점들의 가장자리가 서로 부드럽게 섞이고, `source_type` 색상(teal=session/purple=arxiv/orange=rss/off-white=manual)이 범례 대비 여전히 뚜렷이 구분됨을 확인했다.

### 정리

검증용 임시 디버그 훅(`window.__debugSceneApi`, `app.js`)과 scratch 정적 서버(포트 8899, PID 개별 종료 — 일괄 kill 아님)는 재검증 완료 후 각각 제거·종료 완료. 배포 코드에 잔존하지 않는다.

### 방법론 노트(재사용 가치, 위키에도 별도 기록)

- **코어 좌표 지터도 안전하지 않음**: 라운드 4에서는 임의 좌표가 문서 프록시에 가려질 수 있다는 것까지만 확인했는데, 이번 라운드에서는 **클러스터 코어의 정확한 투영 좌표 자체와 그 주변 소폭 지터**조차 문서가 클러스터 볼륨 전역에 분포해 있어 가려질 수 있음을 추가로 확인했다. 사전 스캔으로 확인된 "안전 좌표"를 우선 사용하고, 실패할 때만 넓은 나선 탐색으로 폴백하는 편이 코어 좌표 지터보다 안정적이다.
- **연속 클릭 자동화의 애니메이션 레이스**: `animateValue()`(scene.js)는 동일 uniform에 대한 이전 트윈을 취소하지 않는다. 그리드 스캔처럼 60ms 간격으로 연속 클릭을 던지면 `clearDocHighlight()`(380ms)와 `highlightDocByIndex()`(220ms)가 겹쳐, 늦게 시작한 clear 트윈이 먼저 끝난 highlight 트윈을 덮어써 결과가 실행마다 달라지는 테스트 하네스 자체 결함이 생길 수 있다. 프로덕션 결함은 아니며, 정적 좌표를 한 번만 정밀 클릭하는 방식으로 회피했다.
- 위 두 항목은 `~/.claude/wiki/threejs-raycaster-nested-hitproxy-shadowing.md`에 재사용 포인트로 추가 기록했다.

## 폴리시 라운드 6 — 피드백 5 재이의 대응 + 문서 파티클 공전(피드백 6)

담당: designer. 범위 동일(`mind/web/` 전용, `mind/src`·`core/`·`contract/` 무접촉). 요청 2건: (1) 팀장이 라운드 5에서 이미 반영·검증된 피드백 5(문서 파티클 반투명화)를 재차 "여전히 불투명 공식"이라고 이의 제기한 건에 대한 재검증 응답, (2) 지금까지 정지해 있던 문서 파티클(`docPoints`)이 소속 클러스터 중심을 천천히 공전하되, 클릭 판정(히트 프록시)·카메라 포커스가 시각 위치와 절대 어긋나지 않게 구현.

### 피드백 5 재검증 — 재확인 결과: 이미 정상 반영되어 있음(회귀 아님, 코드 변경 없음)

라운드 5에서 반영·검증까지 마친 문서 파티클 반투명화가 팀장 쪽에서 "`DOC_POINT_FRAGMENT_SHADER`가 여전히 불투명 공식을 읽는다"는 재이의로 다시 올라왔다. 이번 라운드에서 `scene.js`의 현재 셰이더 소스를 처음부터 다시 확인했다.

- `scene.js`는 저장소 전체에 단 하나만 존재한다(중복 파일·백업 사본 없음).
- `DOC_POINT_FRAGMENT_SHADER` 현재 내용(라인 399~415):
  ```glsl
  float core = smoothstep(0.5, 0.35, d);
  float alpha = core * mix(0.55, 1.0, vGlow);
  ```
  팀장이 인용한 "여전히 불투명한" 대안 공식은 코드베이스 어디에도 존재하지 않는다. 라운드 5가 기록한 반투명 공식과 정확히 일치한다.
- 라운드 5 문서(§ 폴리시 라운드 5 · 피드백 5)에는 라이브 페이지에서 `docPoints.material.fragmentShader` 문자열을 직접 읽어 이 공식이 실제 구동 중임을 확인한 검증 절차와 스크린샷(`fb45-00`~`fb45-05`)까지 이미 기록돼 있다.
- 결론: 디스크상 코드·라이브 셰이더 모두 반투명 공식이며, 이번 재확인에서도 코드 변경은 없었다. 팀장이 확인한 화면이 캐시된 이전 탭/번들이었을 가능성을 조심스럽게 제안한다 — 하드 리프레시(또는 fixture 쿼리에 캐시 무효화 파라미터 추가) 후 재확인을 요청드린다.

### 피드백 6 구현 — 문서 파티클 CPU 사이드 공전

**설계**: `scene.js`의 `tick()` 안에 프레임마다 각 문서의 "현재 공전 위치"를 계산하는 단일 소스를 두고, 그 결과를 세 소비자에 동시에 반영한다.
1. `docGeom`의 position 버퍼(렌더링되는 실제 점 위치)
2. `docHitProxy`(InstancedMesh)의 인스턴스별 행렬(클릭 판정 볼륨)
3. `docCurrentPos` 캐시(`getDocWorldPos(index)`가 읽는 소스) — `sceneApi.getDocWorldPos(index)`를 "현재 살아있는 위치"의 정식 접근자로 노출

**정합성 원칙**: 문서의 정지 좌표 `doc.pos`(픽스처 원본)를 직접 참조해 카메라를 포커스하면, 공전으로 위치가 이동한 뒤엔 빈 옛 자리를 비추게 된다. 이 클래스의 버그를 막기 위해, 문서 위치를 참조해 카메라를 움직이는 모든 경로는 `doc.pos`가 아니라 `sceneApi.getDocWorldPos(index)`(라이브 위치)를 써야 한다는 원칙을 세우고 전체 코드를 점검했다.
- `ask.js`의 출처 인용 클릭 흐름(`sceneApi.highlightDocByIndex(idx); sceneApi.focusOn(sceneApi.getDocWorldPos(idx).toArray(), 26);`)은 이미 이 원칙대로였다(수정 불필요).
- `interactions.js`의 `openDocPanel()`은 정지 좌표를 쓰고 있어 수정: `sceneApi.focusOn(sceneApi.getDocWorldPos(index).toArray(), 26);`(133행 부근)으로 교체.

### 피드백 6 검증

Playwright로 `window.__debugSceneApi`(검증 후 제거, 아래 "정리" 참고)를 통해 라이브 위치·카메라 타깃을 직접 판독하는 3단계 스크립트로 검증했다(픽셀 대조가 아니라 좌표 실측이 1차 증거, 스크린샷은 보조 증거).

- **공전 동작 확인**: 문서 5개(idx 0, 1, 2, 15, 29) 표본을 6초 간격으로 `getDocWorldPos()`로 두 번 읽어 이동 거리를 측정 — 전부 0.19~0.39 월드 단위 이동(`ORBIT_MOTION_DETECTED: true`). 정지해 있지 않고 실제로 공전 중임을 확인.
- **직접 클릭 → 히트 프록시 정합성**: 단일 클러스터(문서 8개)로 줌인한 뒤 목표 문서의 라이브 투영 좌표를 정밀 클릭. 화면상 형제 문서 밀집으로 인해 의도한 문서가 아니라 다른 형제 문서(idx 5)가 열렸는데(→ 별도 함정으로 위키에 추가 기록, 아래 "방법론 노트" 참고), **자기일관성 체크**로 검증 방식을 바꿔 실제로 열린 문서 자신의 라이브 위치가 클릭 지점과 카메라 타깃에 정말 부합하는지 확인했다: 열린 문서의 실측 화면 좌표와 클릭 좌표 거리 `pxDist: 35.12px`(형제 겹침의 크기), 정착 후 카메라 타깃과 그 문서 라이브 위치 간 거리 `distToLive: 0.129` 월드 단위.
- **출처 인용 클릭 → 카메라 포커스 정합성**: `ask.js`의 `highlightDocByIndex`를 래핑해 인용 클릭이 실제로 어떤 문서 인덱스를 가리켰는지 캡처한 뒤, 정착된 카메라 타깃과 그 문서의 라이브 위치를 비교: `distToLive: 0.0389` 월드 단위.
- **판정 근거**: 두 `distToLive` 값(0.129, 0.039)은 같은 세션에서 독립 측정한 공전 자체의 6초당 이동량(0.19~0.39)보다 한 자릿수 작다. 만약 카메라 포커스 로직이 정지 좌표(stale position)를 참조하는 결함이 있었다면, `distToLive`는 공전 누적 이동량 규모이거나 그보다 커야 하고 시간이 지날수록 무한정 벌어져야 한다 — 실측값이 그 반대(공전 규모보다 훨씬 작고 안정적)이므로 두 클릭 경로 모두 라이브 위치를 참조하고 있음을 뒷받침한다.
- 콘솔 에러: 전체 시나리오에서 0건(`CONSOLE_ERROR_COUNT: 0`).
- 스크린샷: `fb6-01-orbit-doc-panel.png`(공전 중인 문서 클릭 → 패널 오픈), `fb6-02-citation-focus.png`(출처 인용 클릭 → 카메라 포커스).

| 시나리오 | 결과 |
|---|---|
| 문서 파티클 공전(6초, 5개 표본) | 통과 — 전부 이동 감지 |
| 공전 중인 문서 클릭 → 패널 오픈(자기일관성) | 통과 — `distToLive 0.129` |
| 출처 인용 클릭 → 카메라 포커스(자기일관성) | 통과 — `distToLive 0.0389` |
| 콘솔 에러 | 통과 — 0건 |

### 정리

검증용 임시 디버그 훅(`window.__debugSceneApi`, `app.js` 90행)은 재검증 완료 후 제거했고, 제거 후 재로드해서 훅 부재(`DEBUG_HOOK_REMOVED: true`)와 콘솔 에러 0건을 재확인했다. 배포 코드에 잔존하지 않는다.

### 방법론 노트(재사용 가치, 위키에도 별도 기록)

- **형제-형제 화면 겹침은 부모/자식 겹침과 별개 문제**: 라운드 5까지는 클러스터(부모)/문서(자식) 계층 겹침만 다뤘는데, 이번 라운드에서 같은 레벨의 문서끼리도(단일 클러스터로 줌인해 형제 간격을 넓힌 뒤에도) 화면상 근접으로 의도와 다른 형제가 클릭될 수 있음을 실측 데이터(`pxDist: 35.12px`)로 확인했다. 프로덕션 결함이 아니라 자연스러운 화면-투영 밀도 문제이며, 올바른 테스트 방법론은 "미리 정한 인덱스가 이겨야 한다"가 아니라 "실제로 열린 대상 자신의 라이브 상태가 클릭·포커스와 일치하는가"를 확인하는 자기일관성 체크다.
- 위 항목은 `~/.claude/wiki/threejs-raycaster-nested-hitproxy-shadowing.md`에 "추가 함정 2"로 별도 기록했다.

## 폴리시 라운드 7 — 별 렌더링

담당: designer. 범위 동일(`mind/web/` 전용, `mind/src`·`core/`·`contract/` 미접촉). 요청: 문서 점을 단순 원형 도트에서 "별처럼" 보이도록 — 밝은 코어 + source_type 색 halo + 십자 회절 스파이크 + 미세 반짝임을 추가하되, 라운드 4~6이 확립한 0.55 기본 알파/`vGlow` 선택 펄스/CPU 사이드 공전 구조/`docHitProxy` 클릭 판정 크기는 전부 보존. 배경 성운 스타필드(`createStarField`, `vTwinkle`)는 이번 범위 밖이라 미접촉.

### 변경 (`scene.js`, `DOC_POINT_VERTEX_SHADER`/`DOC_POINT_FRAGMENT_SHADER`, 376~451행)

라운드 6 종료 시점의 문서 점 셰이더는 단순 원형 코어 하나만 그렸다:

```glsl
// DOC_POINT_FRAGMENT_SHADER (라운드 6 상태)
float core = smoothstep(0.5, 0.35, d);
float alpha = core * mix(0.55, 1.0, vGlow);
```

이번 라운드에서 정점/프래그먼트 셰이더 양쪽을 확장했다.

- **정점 셰이더**(376~409행): `varying float vTwinkle` 신설. `aDocIndex`/`aSize`를 `fract(sin(...)*43758.5453)` 해시로 시드 삼아 파티클마다 다른 위상·주파수의 사인파를 뽑아 `vTwinkle = 1.0 + 0.15*sin(...)`(±15% 진폭)로 계산 — `Math.random()` 미사용, GPU에서 매 프레임 순수 함수로 재계산되는 결정론 값. `gl_PointSize`에 상수 `1.8` 승수를 추가(십자 스파이크가 뻗어나갈 여유 공간 확보)했는데, 이는 시각적 점 크기만 키우는 것으로 `docHitProxy`(별도 InstancedMesh, `docScales` 기반)의 클릭 판정 볼륨과는 무관 — 클릭 판정 크기는 불변.
- **프래그먼트 셰이더**(410~451행): `core`(중심을 흰색 쪽으로 끌어올린 고휘도 스팟, `smoothstep(0.16, 0.0, d)`) + `halo`(source_type 색이 실리는 지수 감쇠 글로우, `exp(-d*6.5)`) + `spikes`(`pow()`/`exp()` 기반 절차적 십자 회절, `armV`+`armH`)를 합성해 `starColor`를 구성. 최종 알파는 `shapeAlpha = clamp(max(core, halo) + spikes, 0.0, 1.0)`에 라운드 5~6이 확정한 `mix(0.55, 1.0, vGlow)`와 신규 `vTwinkle`을 곱한 `alpha = shapeAlpha * mix(0.55, 1.0, vGlow) * vTwinkle` — 기본 반투명/선택 펄스 규칙은 그대로, 적용 대상만 "원 하나"에서 "별의 형태(코어+halo+스파이크) 실루엣 전체"로 확장됐다.
- 색 구분(범례: session=teal `0x2dd4bf`, arxiv=purple `0xa78bfa`, rss=orange `0xfb923c`, manual=off-white `0xe5e7eb`)은 halo가 전담 — 코어는 흰색에 가깝게 끌어올려 색 구분에 쓰지 않는다.
- 배경 스타필드(`createStarField`/`vTwinkle` — 이름은 같지만 문서 점 셰이더와 별개 셰이더)는 미접촉.

### 검증

`page.route('**/web/app.js', ...)`로 디스크는 건드리지 않고 응답 바이트만 메모리 상에서 패치해 `window.__sceneApi`를 노출(검증 전용, `verify-round7.js` 스크립트 실행 시에만 주입). `?fixture=1` 픽스처(문서 30개·클러스터 5개·source_type 4종 전부 포함)로 headless Chromium(swiftshader) 구동.

1. **구문 검사**: 지정된 `node -e "import(...)"` 명령 실행 — `로드 OK(비문법 에러 허용)` 출력, exit 0.
2. **스크린샷(별 형태 식별)**: 와이드 1장(`round7-wide.png`) + source_type 4종 각각 대표 문서를 `focusOn(getDocWorldPos(idx), 26)`으로 화면 중앙 정렬 후 클로즈업 4장(`round7-closeup-{session,arxiv,rss,manual}.png`). 5장 전부 육안 확인: 밝은 백색 코어 중심 + 다중 미세 사이즈의 4방향 십자 스파이크 + 배경 성운 색과 구분되는 옅은 halo 색조가 뚜렷이 관찰됨(`round7-wide.png`에서 5개 클러스터 색·범례·UI 전부 정상 렌더, `round7-closeup-session.png`/`round7-closeup-arxiv.png`에서 코어+halo+스파이크 형태 직접 확인).
3. **클릭 리그레션**: 마지막 포커스 문서(`manual` 타입)의 라이브 월드 좌표를 `THREE.Vector3.project(camera)`로 실제 화면 픽셀에 투영, `page.mouse.click(x, y)`로 진짜 캔버스 클릭 이벤트 발생(실제 `onClick`→`raycastAtClient`→`openDocPanel` 경로). `panelOpenBefore: false` → `panelOpenAfter: true`, `panelTitle: "Cloudflare Workers 블로그 업데이트"`, `panelKind: "문서"` — 정상 오픈 확인. 스크린샷 `round7-clicked-panel.png`.
4. **콘솔 에러**: 전체 시나리오(로드~클로즈업 4종~클릭)에서 총 메시지 6건 중 에러 0건.
5. **외부 네트워크 요청**: 총 요청 12건 중 `127.0.0.1`/`localhost` 외 출처 0건.

| 항목/시나리오 | 결과 |
|---|---|
| 구문 검사(`node -e import`) | 통과 — exit 0, "로드 OK" |
| 별 형태(코어+halo+스파이크) 육안 식별 | 통과 — 와이드 1 + 클로즈업 4, 전부 확인 |
| source_type 4종 색 구분 | 통과 — session/arxiv/rss/manual 클로즈업 각 1장씩 확보 |
| 클릭 리그레션(실 좌표 투영 → 실 클릭) | 통과 — `panelOpenBefore=false → panelOpenAfter=true`, 제목/종류 정상 |
| 콘솔 에러 | 통과 — 0/6건 |
| 외부 네트워크 요청 | 통과 — 0/12건 |

스크린샷 경로(전부 `C:\Users\User\AppData\Local\Temp\claude\D--\ff47b6df-536a-425c-81b2-9da4f449aacb\scratchpad\` 하위):
`round7-wide.png`, `round7-closeup-session.png`, `round7-closeup-arxiv.png`, `round7-closeup-rss.png`, `round7-closeup-manual.png`, `round7-clicked-panel.png`.

### 방법론 노트

- `~/.claude/wiki/webgl-readpixels-race-headless-verification.md`의 권고를 그대로 적용 — `gl.readPixels()`를 렌더 루프 밖에서 호출하는 방식은 전혀 쓰지 않았고, `page.screenshot()`(Chromium 정식 컴포지팅 경로)만으로 시각 증거를 확보했다.
- 클릭 리그레션은 미리 정한 화면 좌표를 재사용하지 않고, 매번 `THREE.Vector3.project(camera)`로 그 순간의 라이브 위치를 재계산해 좌표를 구했다 — 라운드 4·6에서 발견된 "정지/재사용 좌표가 카메라·형제 파티클과 어긋나는" 클래스의 함정을 원천 회피.
- 이번 라운드는 `app.js` 디스크 파일을 전혀 수정하지 않았다(라운드 4~6처럼 `window.__debugSceneApi` 훅을 코드에 추가했다가 검증 후 제거하는 절차 자체가 불필요) — `page.route()`로 응답 바이트만 메모리 상에서 패치(`window.__sceneApi` 주입)했고, 브라우저 종료와 함께 흔적 없이 사라진다. 별도 "정리" 단계 불필요.

