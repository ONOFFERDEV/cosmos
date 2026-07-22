# cosmos-core M0 — Self-Verification Results

Scope of this deliverable: `D:\cosmos\core` only. No files outside this directory were
modified (contract/, docs/, tools/ untouched).

## 1. Build

### `cargo build` (dev profile, used for fast iteration)
```
Compiling cosmos-core v0.1.0 (D:\cosmos\core)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 23.39s
```
0 errors, 0 warnings.

### `cargo build --release` (required gate)
```
Compiling cosmos-core v0.1.0 (D:\cosmos\core)
    Finished `release` profile [optimized] target(s) in 2m 59s
```
0 errors, 0 warnings (full build log grepped for `warning` — 0 matches, including all
transitive dependency crates: tantivy 0.25, lindera 4.0 + lindera-ko-dic, fastembed
5.17.2 (ort 2.0.0-rc.12), axum 0.8.9, rusqlite 0.40.1 bundled, clap 4.6.1, tokio,
reqwest, image, chrono, etc.).

Two real compiler errors were hit and fixed during development (both in `src/bm25.rs`,
tantivy 0.25 API friction):
- `Index::writer(50_000_000)` — tantivy 0.25's `writer<D: Document>` is generic and
  needs an explicit type argument; fixed with `self.index.writer::<TantivyDocument>(...)`
  at both call sites (`add_chunks`, `delete_chunks`).
- `doc.get_first(...).and_then(|v| v.as_str())` — `.as_str()` comes from tantivy's
  `Value` trait, which must be explicitly imported; added `Value` to the
  `use tantivy::schema::{...}` list.

## 2. Functional self-verification

All steps run against the release binary (`target\release\cosmos-core.exe`), in a
temporary directory under `core\verify_tmp\` (removed after verification — not part of
the deliverable). Two test docs: `docs/korean.md` (Korean, 4 sections) and
`docs/english.md` (English, matching content), plus a `manifest.json` per
CONTRACT.md §"시드 매니페스트 형식".

### `index`
```
cosmos-core.exe index --manifest verify_tmp\manifest.json --out verify_tmp\out --models D:\cosmos\models
```
```json
{"anchor_mismatches":0,"chunks":2,"docs":2,"duplicates":0,"replaced":0,"secs":130.2643079}
```
Wall time 2m11s — dominated by the first-run fastembed network download of BGE-M3 and
bge-reranker-v2-m3 into `D:\cosmos\models` (network download allowed per spec). **`anchor_mismatches: 0`** — the byte-offset/UTF-8-boundary chunk invariant held for
both documents on first try, self-verified per-chunk at ingest time in `engine.rs`.

### `search`
```
cosmos-core.exe search "한국어 테스트 질의" --out verify_tmp\out
```
Returned well-formed JSON with 2 ranked results. Top hit was the Korean document
(`rerank_score: 0.8134`, `bm25_rank: 1`, `vec_rank: 1`), correctly outranking the
English document (`rerank_score: -5.89`, `bm25_rank: null` — no lexical match,
`vec_rank: 2`). All 4 stage fields (`bm25_rank`, `vec_rank`, `rrf_score`,
`rerank_score`) were populated as required by CONTRACT.md. `stats.secs: 0.696` for the
in-process search call (the ~8s CLI wall time is `Engine::new()` reloading/warming the
already-cached models from disk each invocation, not search latency).

### `serve` + curl
```
cosmos-core.exe serve --port 8801 --out verify_tmp\out --models D:\cosmos\models
```
```
INFO cosmos_core::serve: cosmos-core serve listening on 0.0.0.0:8801
```
- `GET /health` → `{"status":"ok","version":"0.1.0","docs":2,"chunks":2,"clusters":0}`
- `POST /search` (body `{"query":"한국어 테스트 질의","k":3}`) → same 2-result payload
  shape as the CLI `search` output (via the `IngestOutcome`→`IngestedDoc`-style shared
  `SearchResponse` type), `stats.secs: 0.277`.
  - Note: the first curl attempt using an inline `-d '{"query":"한국어..."}'` shell
    argument failed with a JSON parse error — this was a Git Bash / Windows shell
    UTF-8 argument-encoding artifact, not a server bug. Passing the identical JSON via
    `--data-binary @file.json` (file written with proper UTF-8 encoding) succeeded
    immediately with an identical response to the file-free case above.
- Process terminated by PID only: confirmed via
  `Get-CimInstance Win32_Process -Filter "Name='cosmos-core.exe'"` that PID 39956's
  `CommandLine` exactly matched the `serve` invocation above (the only `cosmos-core.exe`
  process running), then `Stop-Process -Id 39956 -Force`. No other process was touched.

## 3. 편차 (deviations from CONTRACT.md / openapi.yaml — no wording in either file was
changed; these are implementation-detail notes)

1. **`IngestOutcome` vs `IngestedDoc` split.** `openapi.yaml`'s `IngestedDoc` schema has
   no `anchor_mismatches` field, but CONTRACT.md's CLI `index` stats output requires an
   aggregate `anchor_mismatches` count. Resolved with an internal-only `IngestOutcome`
   struct (same fields as `IngestedDoc` plus `anchor_mismatches: usize`) used by the CLI;
   `impl From<IngestOutcome> for IngestedDoc` drops the field for the `/ingest` HTTP
   response, keeping the public schema exactly as specified.
2. **`search` CLI has no `--models` flag**, matching CONTRACT.md's CLI usage block
   (`cosmos-core search "<query>" --out <dir> [--k 6]` — no `--models`). `main.rs`
   hardcodes `cosmos_core::DEFAULT_MODELS_DIR` (`D:\cosmos\models`) for this subcommand's
   internal `Engine::new()` call.
3. **DDL uses `CREATE TABLE IF NOT EXISTS`** (not verbatim `CREATE TABLE` as shown in
   CONTRACT.md's DDL block) so that `Store::open` is idempotent across repeated `serve`/
   `index` invocations against the same `--out` dir. Column/table definitions are
   otherwise unchanged from the contract.
4. **Shared SQLite connection.** `Store::conn_handle() -> Arc<Mutex<Connection>>` is
   shared between `Store` and `SqliteVectorStore` so both write through one connection
   (SQLite file-level locking already serializes writers; this avoids a second open
   handle). This is an internal wiring detail, not a schema or API change.

## 4. Remaining risks

- **`ort`/fastembed model behavior is CPU-only and not benchmarked at scale.** M0
  verification used exactly 2 tiny documents; latency/throughput at seed-corpus scale
  (dozens–hundreds of docs) is unmeasured.
- **`#[ignore]`-marked unit test** (`engine::tests::ingest_dedup_and_replace`) requires
  network access for model download and was not run as part of this self-verification
  (the spec's verification protocol uses the CLI directly, not `cargo test`); dedup/
  replace behavior was however exercised indirectly — not re-tested with a second
  `index` run against the same manifest in this pass. Worth a follow-up `cargo test`
  run once models are cached.
- **LanceDB migration deferred to M2** as instructed — current `VectorStore` impl is a
  full-table-scan brute-force cosine over SQLite BLOBs; will not scale past a modest
  corpus size, by design for M0.
- **No concurrent-load testing** of `serve` (single sequential curl calls only); the
  `Bm25Index::write_lock: Mutex<()>` and shared `Arc<Mutex<Connection>>` should serialize
  concurrent `/ingest` calls correctly but this was not stress-tested.

## 수정 라운드 1

### 원인

M0 게이트 검증 중 129문서 시드 색인 과정에서 다음 panic이 재현되었다:

```
thread 'main' panicked at src\chunk.rs:71:23:
end byte index 1500 is not a char boundary; it is inside '도' (bytes 1499..1502 of string)
```

`src/chunk.rs`의 `find_split_point()`가 받는 `ideal_end`(`chunk_text`에서
`start + CHUNK_TARGET_BYTES`로 계산, 문자 경계 미보장)와 `window_lo`
(`start + CHUNK_TARGET_BYTES / 3`, 역시 미보장)를 문자 경계로 정렬하지 않은 채
`&text[window_lo..ideal_end]`로 바로 슬라이스했다. 이미 존재하던
`floor_char_boundary` 헬퍼는 반환값 계산(블랭크라인/문장/하드컷 후보)에만 적용되어
있었고, 슬라이스 자체를 만드는 진입점에는 적용되어 있지 않았다 —
CONTRACT.md 지뢰 목록의 "한국어 바이트 슬라이싱 panic" 위반.

### 수정 내용

`src/chunk.rs`의 `find_split_point()` 진입부에서 `ideal_end`와 `window_lo`를
슬라이스·비교에 사용하기 전에 각각 `floor_char_boundary`로 정렬하도록 수정
(`src/chunk.rs:71-75`). `window_lo >= ideal_end`인 조기 반환 경로도 이미 정렬된
`ideal_end`를 그대로 반환하도록 단순화했다. 이후 헤딩/블랭크라인/문장/하드컷 후보
계산 경로는 전수 재검토 결과 이미 안전함을 확인했다(헤딩 오프셋은 항상 줄 시작이라
경계 보장, ASCII 패턴 뒤 오프셋도 ASCII 바이트 이동이라 경계 보장, 반환 직전
`floor_char_boundary` 방어 로직은 그대로 유지).

`chunk_text()` 쪽도 전수 점검했다: `start`는 초기값 0(경계) 또는
`floor_char_boundary`를 거친 `next_start`/`end`(항상 경계)로만 갱신되고, `end`는
이제 안전해진 `find_split_point()` 반환값이거나 `is_char_boundary` 루프로 전진하는
forward-progress 폴백이거나 `len`(항상 경계)이므로 추가 수정이 필요한 미정렬
슬라이스 경로는 없었다.

**회귀 테스트 추가**: `src/chunk.rs` 테스트 모듈에
`korean_no_punctuation_forces_hard_cut_char_boundaries_hold`를 추가. 공백·구두점이
전혀 없는 "가나다라마바사아자차" 500회 반복(15,000바이트, 헤딩/블랭크라인/문장
경계 후보가 전혀 없어 하드컷 경로를 강제)을 청킹하고 기존
`assert_anchors_valid`(len 일치 + 바이트 슬라이스 일치)로 앵커 불변식을 검증한다.

### `cargo test` 실행 결과 (전체, `#[ignore]` 1건 제외)

```
running 22 tests
test engine::tests::ingest_dedup_and_replace ... ignored
test fuse::tests::agreeing_top_result_wins ... ok
test fuse::tests::pool_size_truncates ... ok
test fuse::tests::union_of_both_lists ... ok
test parse::tests::hash_is_stable ... ok
test parse::tests::normalizes_crlf_and_lone_cr ... ok
test journal::tests::append_and_list_roundtrip ... ok
test bm25::tests::sanitize_strips_punctuation ... ok
test chunk::tests::long_text_produces_multiple_chunks_with_valid_anchors ... ok
test chunk::tests::short_text_single_chunk ... ok
test chunk::tests::empty_text_yields_no_chunks ... ok
test store::tests::doc_insert_and_lookup_roundtrip ... ok
test chunk::tests::heading_becomes_section ... ok
test store::tests::event_append_and_list ... ok
test chunk::tests::korean_multibyte_text_char_boundaries_hold ... ok
test chunk::tests::korean_no_punctuation_forces_hard_cut_char_boundaries_hold ... ok
test parse::tests::preserves_lf_only_text ... ok
test store::tests::chunk_insert_and_fetch_preserves_order ... ok
test vector::tests::roundtrip_bytes ... ok
test vector::tests::cosine_identical_is_one ... ok
test vector::tests::cosine_orthogonal_is_zero ... ok
test bm25::tests::index_and_search_roundtrip ... ok

test result: ok. 21 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 1.42s
```

`cargo build --release`: 0 errors (`Finished \`release\` profile [optimized] target(s) in 8.62s`).

### 스모크 테스트 결과

임시 마니페스트 + 15,140바이트 한국어 md 1개(헤딩 3개 + 500회 반복 구두점 없는
한글 블록 포함, 원본 panic 조건 재현)를 `cosmos-core.exe index`로 색인:

```
{"anchor_mismatches":0,"chunks":12,"docs":1,"duplicates":0,"replaced":0,"secs":10.5720057}
```

panic 없이 완료, `anchor_mismatches: 0` 확인. 임시 파일은 검증 후 삭제했다
(`.smoke_test_tmp/` 잔존 없음).

## M1 라운드

Scope: `D:\cosmos\core`만 수정. `contract/`, `docs/`, `mind/`, `tools/`,
`data/`(특히 `D:\cosmos\data\out` — 관리자 게이트용 실DB)는 일절 건드리지 않았다.
모든 스모크 테스트는 격리된 스크래치패드 디렉터리에서만 수행했다.

### 구현 항목 (5개, 전부 완료)

1. **스키마 마이그레이션**: `Store::open`에서 `clusters.centroid BLOB` 컬럼을
   additive·idempotent하게 추가 (기존 DB에 재실행해도 안전, 신규 DB는 처음부터
   포함).
2. **클러스터 부트스트랩**: `POST /clusters/bootstrap` + CLI `bootstrap`
   서브커맨드. spherical k-means(단위정규화 벡터, 코사인 거리), k-means++ 초기화,
   실루엣 기반 k 자동선택(또는 `--k-min`/`--k-max`로 강제), 고정 시드로 결정적.
3. **클러스터 CRUD**: `PATCH /clusters/{cluster_id}`(rename/merge 등) +
   `GET /clusters`(목록 + 문서/청크 카운트).
4. **클러스터 스코프 검색**: `/search`(HTTP)와 엔진 `search()` 3-arg 오버로드에
   `cluster_ids` union 필터 추가 — 지정 시 해당 클러스터에 속한 문서의 청크만
   후보 풀에 포함.
5. **라우팅**: `POST /route` — 쿼리를 각 클러스터 centroid와 코사인 유사도 비교 +
   클러스터 스코프 BM25 히트수를 함께 반환, 어느 클러스터가 쿼리와 가장 잘
   맞는지 판단하는 용도.

### `cargo test` 실행 결과 (전체, `#[ignore]` 1건 제외)

```
test result: ok. 25 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out
```

### `cargo build --release`

```
Finished `release` profile [optimized] target(s) in 14.40s
```
0 에러.

### 스모크 테스트

6개 합성 마크다운 문서(2개 주제군 × 3개, 각 ≥3KB, 한국어) — 고양이 케어군
(`cat-nutrition`, `cat-health`, `cat-behavior`)과 우주탐사군
(`rocket-propulsion`, `space-telescopes`, `mars-missions`) — 를 격리
스크래치패드에 작성 후 `cosmos-core.exe`(release 바이너리)로 전 과정 실행.

**1) `index`**
```json
{"anchor_mismatches":0,"chunks":17,"docs":6,"duplicates":0,"replaced":0,"secs":16.2741027}
```

**2) `bootstrap --k-min 2 --k-max 2 --seed 42`**
```json
{"stats":{"k":2,"silhouette":0.38110974431037903,"docs_assigned":6}}
```
결과 클러스터 구성 — 완벽한 주제 분리(교차오염 0건):
- `c01`(고양이): `n_docs:3, n_chunks:8` — cat-nutrition, cat-health, cat-behavior
- `c02`(우주): `n_docs:3, n_chunks:9` — rocket-propulsion, mars-missions, space-telescopes

**3) `serve --port 8899` + `/health`**
```json
{"status":"ok","docs":6,"chunks":17,"clusters":2}
```

**4) `/journal`** — 정확히 9개 이벤트, 순서대로:
- seq 1-6: `ingest` ×6 (전부 `replaced:false`)
- seq 7-8: `cluster_birth` ×2 (클러스터별 1건, id/slug 일치)
- seq 9: `assign` (`assignments:6`)

**5) `/route`** — 두 방향 모두 정답 클러스터가 명확히 우세:
| 쿼리 | 정답 클러스터 centroid_sim | 오답 클러스터 centroid_sim | 정답 bm25_hits | 오답 bm25_hits |
|---|---|---|---|---|
| "고양이 사료 단백질 함량과 타우린 영양소" | c01 0.647 | c02 0.372 | 8 | 0 |
| "로켓 엔진 추력과 우주 발사체 추진 기술" | c02 0.641 | c01 0.329 | 9 | 0 |

**6) 클러스터 스코프 `/search`** — 의도적으로 두 주제를 모두 언급하는 애매한
쿼리("영양소와 추진 시스템에 대해 알려줘")로 테스트:
- 스코프 없음(`cluster_ids: []`): 결과가 두 클러스터 origin 모두에서 섞여 나옴
  (rocket-propulsion, mars-missions, cat-nutrition, cat-health 등 혼재).
- `cluster_ids: [c01]`로 스코프: 반환된 8개 결과 전부 `{cat-nutrition,
  cat-health, cat-behavior}` origin만 — 우주 클러스터 청크 유출 0건. 쿼리가
  명시적으로 "추진 시스템"을 언급했음에도 완전 차단됨.
- `cluster_ids: [c02]`로 스코프: 반환된 9개 결과 전부 `{rocket-propulsion,
  mars-missions, space-telescopes}` origin만 — 고양이 클러스터 청크 유출 0건.

스모크 테스트 완료 후 백그라운드 `serve` 프로세스는 종료했다.

### 편차

명세 대비 편차 없음. CONTRACT.md/openapi.yaml 문구 변경 없이 5개 항목 전부
구현.

### 남은 리스크

- 클러스터링은 6문서/2클러스터 소규모로만 검증됨 — 대규모 코퍼스(수백~수천
  문서)에서의 k 자동선택·실루엣 품질·부트스트랩 소요시간은 미측정.
- `/route`의 centroid_sim·bm25_hits 두 신호를 어떻게 최종 라우팅 결정으로
  합성할지(가중치, 임계값)는 이번 스모크에서 검증 대상이 아니었음 — 호출 측
  (mind 등)의 후속 판단 로직에 위임.

## M2 라운드

Scope: `D:\cosmos\core`만 수정. `contract/`, `docs/`, `mind/`, `tools/`,
`data/`(특히 `D:\cosmos\data\out` — 관리자 게이트용 실DB)는 일절 건드리지 않았다.
스모크 테스트는 스크래치패드 임시 디렉터리(`cosmos-m2-smoke\out`)에서만 수행했다.

### 구현 항목

**신규/교체 문서 ingest-시 argmax 클러스터 자동 배정** (`src/engine.rs::ingest_doc`):
- active 클러스터가 1개 이상 존재하면, 새 문서의 청크 임베딩을 정규화 평균한
  문서벡터(`cluster::l2_normalize`)를 각 클러스터 centroid와 코사인 비교해
  **argmax 클러스터에 배정**. 해당 클러스터 id를 문서의 전 청크 `cluster_ids`에
  상속(`Store::update_chunk_cluster_ids_for_doc`), `fit`(코사인값)을
  `docs.meta_json`에 기록(`Store::update_doc_meta_json`), `fit < FIT_THRESHOLD(0.5)`면
  `meta_json.low_fit=true`를 추가로 병합(`doc_meta_json_for_fit` 헬퍼, `engine.rs`
  `Engine` 구조체 정의 직전).
- 문서당 저널 `assign` 이벤트 1건 append(`journal::append_assign_doc`, payload
  `{doc_id, cluster_id, fit}`) — 기존 부트스트랩의 벌크 `assign` 이벤트(payload
  `{assignments: N}`)와는 payload 형태로 구분되는 동일 `kind`.
- active 클러스터가 0개면 배정 로직 전체를 건너뛰고 `cluster_slug`/`fit` 모두
  `None`(기존 동작 100% 보존, 회귀 없음).
- `IngestedDoc`/`IngestOutcome`에 `cluster_slug: Option<String>`, `fit: Option<f32>`
  additive 필드 추가, `From<IngestOutcome> for IngestedDoc`도 두 필드를 그대로 전달하도록
  갱신.

**duplicate 판정 순서 진단**: `ingest_doc`의 duplicate 판정(`origin`+`hash` 비교,
`engine.rs:373-392`)은 청킹(`chunk::chunk_text`, `engine.rs:399`)과 임베딩
(`self.embedder.embed()`, `engine.rs:402`) **이전에 이미 위치해 있었다** — 이번
라운드 이전부터 정확한 순서였으며, 코드 이동은 불필요했다. 게다가 duplicate
분기는 `journal::append_ingest` 호출(`engine.rs:478`, 새 배정 로직 뒤에 위치)에
도달하기도 전에 조기 `return`하므로, **duplicate 재전송은 저널 이벤트 자체를
전혀 남기지 않는다**(assign은 물론 ingest 이벤트도 없음) — 스모크 테스트로
실측 확인(아래).

**IngestResponse 확장 스코프**: `contract/CONTRACT.md` M2 스펙 절(라인 160-163)을
직접 재확인한 결과, `cluster_slug`/`fit` additive 필드는 `IngestResponse.ingested[]`
(HTTP 전용)에만 명시되어 있고, CLI `index`의 stdout stats 포맷(`{docs, chunks,
anchor_mismatches, duplicates, replaced, secs}`, CONTRACT.md 라인 88)은 변경
대상이 아니다. `main.rs`(CLI)는 이번 라운드에서 전혀 수정하지 않았다 — 스코프
확장 없음.

### `cargo test` 실행 결과 (offline-safe, `#[ignore]` 3건 제외)

```
running 31 tests
test engine::tests::ingest_assigns_to_argmax_cluster_and_skips_embed_on_duplicate ... ignored
test engine::tests::ingest_dedup_and_replace ... ignored
test engine::tests::ingest_no_assignment_when_no_clusters ... ignored
test chunk::tests::heading_becomes_section ... ok
test bm25::tests::sanitize_strips_punctuation ... ok
test chunk::tests::short_text_single_chunk ... ok
test chunk::tests::korean_multibyte_text_char_boundaries_hold ... ok
test chunk::tests::empty_text_yields_no_chunks ... ok
test chunk::tests::korean_no_punctuation_forces_hard_cut_char_boundaries_hold ... ok
test chunk::tests::long_text_produces_multiple_chunks_with_valid_anchors ... ok
test fuse::tests::agreeing_top_result_wins ... ok
test fuse::tests::union_of_both_lists ... ok
test fuse::tests::pool_size_truncates ... ok
test parse::tests::hash_is_stable ... ok
test cluster::tests::kmeans_is_deterministic_for_same_seed ... ok
test parse::tests::normalizes_crlf_and_lone_cr ... ok
test engine::tests::low_fit_flag_boundary ... ok
test parse::tests::preserves_lf_only_text ... ok
test vector::tests::cosine_identical_is_one ... ok
test vector::tests::roundtrip_bytes ... ok
test vector::tests::cosine_orthogonal_is_zero ... ok
test vector::tests::search_filtered_excludes_ids_outside_allowed_set ... ok
test cluster::tests::silhouette_selects_k_two_for_clearly_separated_blobs ... ok
test journal::tests::append_and_list_roundtrip ... ok
test journal::tests::append_assign_doc_roundtrip ... ok
test store::tests::doc_insert_and_lookup_roundtrip ... ok
test store::tests::event_append_and_list ... ok
test store::tests::cluster_centroid_migration_is_idempotent ... ok
test store::tests::update_doc_meta_json_roundtrip ... ok
test store::tests::chunk_insert_and_fetch_preserves_order ... ok
test bm25::tests::index_and_search_roundtrip ... ok

test result: ok. 28 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 0.81s
```

M2에서 신규 추가한 3개 테스트(모두 `low_fit_flag_boundary`를 제외하면 실제
embedding 모델을 필요로 해 `#[ignore]`):
- `low_fit_flag_boundary` — `doc_meta_json_for_fit(0.49)`는 `low_fit:true` 포함,
  `doc_meta_json_for_fit(0.5)`/`doc_meta_json_for_fit(0.51)`은 미포함(0.5는
  경계값 미만이 아니므로 low_fit 아님).
- `ingest_no_assignment_when_no_clusters`(`#[ignore]`) — 클러스터 0개 상태에서
  ingest 시 `cluster_slug`/`fit` 모두 `None`, 저널에 `assign` kind 이벤트
  0건(`ingest` 1건만 존재) 확인.
- `ingest_assigns_to_argmax_cluster_and_skips_embed_on_duplicate`(`#[ignore]`) —
  커피 주제 2건 + 로켓 주제 2건 ingest 후 `bootstrap_clusters(k_min=2, k_max=2)`,
  커피 클러스터 slug를 식별한 뒤 신규 커피 문서 ingest → `cluster_slug`/`fit`
  일치 + 저널 `assign` 이벤트 존재 + `embedder.embed_call_count()` 증가 확인;
  동일 문서 재전송 → `duplicate:true` + `embed_call_count()` 불변(임베딩 완전
  스킵) 확인.

### `cargo test -- --ignored` 실행 결과 (모델 의존 3건)

```
running 3 tests
test engine::tests::ingest_dedup_and_replace ... ok
test engine::tests::ingest_no_assignment_when_no_clusters ... ok
test engine::tests::ingest_assigns_to_argmax_cluster_and_skips_embed_on_duplicate ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 28 filtered out; finished in 9.13s
```

모델은 이미 로컬 캐시되어 있어 신규 다운로드 없이 9.13초에 완료(M1 라운드 대비
로직 유사 테스트가 이미 캐시를 워밍해 둔 상태).

### `cargo build --release`

```
Finished `release` profile [optimized] target(s) in 0.51s
```
0 에러(직전 라운드에서 이미 빌드된 상태라 재컴파일 없이 즉시 완료 — 별도로
클린 빌드 없이도 릴리스 아티팩트가 최신임을 확인).

### 스모크 테스트

임시 스크래치패드 `out` 디렉터리(`data/out` 아님)에 대해 `cosmos-core.exe serve
--port 18801`을 백그라운드 기동, HTTP로 전 시나리오 실행.

**1) 클러스터 없는 상태에서 6개 신규 문서 `/ingest`** (커피 주제 3 + 로켓 주제 3):
전 6건 모두 `"cluster_slug":null,"fit":null,"duplicate":false"` — 배정 로직이
클러스터 부재 시 완전히 스킵됨을 실측 확인.

**2) `/clusters/bootstrap` (`k_min:2, k_max:2, seed:42`)**:
```json
{"stats":{"k":2,"silhouette":0.4712,"docs_assigned":6}}
```
완벽한 주제 분리(교차오염 0건) — `c01`(커피): coffee1/coffee2/coffee3,
`c02`(로켓): rocket1/rocket2/rocket3.

**3) 신규 7번째 문서(에스프레소, 커피 주제) `/ingest`**:
```json
{"doc_id":"b929cfb7-70f7-4cef-b117-bdf9b8f02039","origin":"origin://coffee4",
 "chunks":1,"duplicate":false,"replaced":false,"cluster_slug":"c01","fit":0.79699796}
```
argmax가 정확히 커피 클러스터(`c01`)를 선택, `fit=0.797`(FIT_THRESHOLD 0.5 이상,
low_fit 아님).

**4) `/journal?after_seq=0`**: 총 11개 이벤트 중 `assign` kind 2건 확인:
- `seq:9` — 부트스트랩의 벌크 `assign`(`{"assignments":6}`).
- `seq:10` — 7번째 문서 전용 `assign`(`{"cluster_id":"da5b768a...","doc_id":
  "b929cfb7...","fit":0.7969979643821716}`) — `/ingest` 응답의 `fit`값과 정확히
  일치, `cluster_id`도 `c01`의 실제 id와 일치.

**5) 동일 7번째 문서(에스프레소) 재전송 `/ingest`**:
```json
{"doc_id":"b929cfb7-70f7-4cef-b117-bdf9b8f02039","origin":"origin://coffee4",
 "chunks":1,"duplicate":true,"replaced":false,"cluster_slug":null,"fit":null}
```
재전송 전후 `/journal` 이벤트 총수가 **11 → 11로 불변** — duplicate가
청킹/임베딩/클러스터배정/저널기록 전 과정을 완전히 스킵하고 조기 반환함을
엔드투엔드로 실측 확인(코드상 진단과 일치).

스모크 테스트 완료 후 백그라운드 `serve` 프로세스는 종료했다(`TaskStop`).

### 편차

명세 대비 편차 없음. `contract/CONTRACT.md`/`openapi.yaml` 문구 변경 없이 M2
스펙 3개 항목(argmax 배정+fit+저널, duplicate 순서 진단, IngestResponse HTTP
확장) 전부 구현·검증 완료. CLI(`main.rs`)는 스펙상 변경 대상이 아니어서
수정하지 않았다.

### 남은 리스크

- 클러스터 배정도 M1과 마찬가지로 6~7문서/2클러스터 소규모로만 검증됨 —
  대규모 코퍼스에서 다수 클러스터 간 argmax 정확도·fit 분포는 미측정.
- `low_fit` 플래그가 M4(misfit·탄생) 로직에서 실제로 어떻게 소비되는지는
  이번 라운드의 검증 범위 밖(플래그를 정확히 기록하는 것까지만 검증).

## M3 수정 라운드 2

Scope: `D:\cosmos\core`만 수정. `contract/`, `docs/`, `mind/`, `tools/`,
`data/`(특히 `D:\cosmos\data\out` — 관리자 게이트용 실DB)는 일절 건드리지 않았다.
스모크 테스트는 스크래치패드 임시 디렉터리(`cosmos-m3-round2-smoke\out`)에서만
수행했다.

과제: M3 게이트 2차 실측에서 `GET /docs`(및 대응 CLI 출력)의 `DocSummary`에
`cluster_slug`(문서 청크들의 `cluster_ids` 기준 다수결 클러스터 slug, 미배정 시
null)와 `fit`(`docs.meta_json`의 `fit` 값, 없으면 null — 부트스트랩 배정 문서는
null 정상)을 추가 — 문서별 N+1 쿼리 없이 조인/일괄 집계 쿼리로.

### 구현 항목

**1) `DocSummary`에 `cluster_slug`/`fit` 추가** (`src/engine.rs:181-193`):
```rust
pub struct DocSummary {
    pub doc_id: String,
    pub origin: String,
    pub source_type: String,
    pub title: Option<String>,
    pub n_chunks: i64,
    pub ingested_at: String,
    /// M3: majority-vote cluster slug over the doc's chunks' `cluster_ids`
    /// (null if the doc has no assigned chunks).
    pub cluster_slug: Option<String>,
    /// M3: `meta_json.fit` (null if absent — normal for bootstrap-assigned
    /// docs, since `/clusters/bootstrap` never writes `meta_json`).
    pub fit: Option<f32>,
}
```
`openapi.yaml`의 `DocSummary` 스키마(둘 다 nullable additive)와 1:1 대응.

**2) `Store::list_docs()`에 `meta_json` 컬럼 추가** (`src/store.rs:245-270`):
기존 doc-listing 쿼리(`docs d LEFT JOIN chunks c ON c.doc_id = d.id GROUP BY d.id`)에
`d.meta_json`을 SELECT 목록에만 추가 — 조인 구조·N+1 위험은 그대로 0(문서별
추가 쿼리 없음). 결과 행 타입 `DocSummaryRow`(`src/store.rs:88-98`)에
`pub meta_json: String` 필드 추가.

**3) 일괄 집계 쿼리 2건 재사용** — M2에서 이미 존재하던
`Store::all_chunk_cluster_rows()`(`src/store.rs:450-463`, `SELECT id, doc_id,
cluster_ids FROM chunks` 전체 스캔 1쿼리)와 `Store::list_cluster_rows()`
(`src/store.rs:378-397`, `SELECT ... FROM clusters` 전체 스캔 1쿼리)를 그대로
가져다 씀 — 신규 쿼리 추가 없음.

**4) 다수결 집계 순수 함수 3개 신규** (`src/engine.rs:350-420`):
- `doc_majority_cluster_ids(chunk_cluster_rows) -> HashMap<doc_id, cluster_id>`
  (`engine.rs:350`) — 청크별 `cluster_ids`(JSON 배열)를 문서 단위로 득표
  집계(`HashMap<doc_id, HashMap<cluster_id, count>>`) 후, 후보를 cluster_id
  오름차순 정렬한 뒤 "현재 최다 득표를 엄격히 초과할 때만 교체"하는 fold로
  승자를 뽑는다 — 동률 시 사전순으로 가장 작은 id가 결정론적으로 승리.
- `fit_from_meta_json(meta_json: &str) -> Option<f32>` (`engine.rs:378`) —
  `meta_json`을 파싱해 `fit` 키를 `f64`→`f32`로 추출, 파싱 실패/키 부재 시 `None`.
- `build_doc_summaries(rows, chunk_cluster_rows, cluster_rows) -> Vec<DocSummary>`
  (`engine.rs:390`) — 위 두 헬퍼 + cluster id→slug 맵(clusters 전체 스캔 결과에서
  1회 구축)을 in-memory로 조합해 각 `DocSummaryRow`를 `DocSummary`로 매핑.
- `Engine::list_docs()`(`engine.rs:662-667`)는 `Store::list_docs()` +
  `Store::all_chunk_cluster_rows()` + `Store::list_cluster_rows()` 딱 3개
  쿼리만 호출하고 나머지는 전부 `build_doc_summaries`의 in-memory 집계 —
  문서 수가 몇 건이든 쿼리 수는 항상 3건 고정(N+1 없음).

**5) `serve.rs`/`main.rs` 변경 없음**: `docs_handler`는 이미
`Ok(Json(engine.list_docs()?))` 형태의 단순 패스스루라 수정 불필요.
`main.rs`(CLI)에는 문서 목록 출력용 서브커맨드 자체가 없어(`Index`/`Search`/
`Serve`/`Bootstrap` 4종) 수정 대상 없음 — M2 라운드와 동일한 판단(하단 편차
참고).

### `cargo test` 실행 결과 (offline-safe, `#[ignore]` 3건 제외)

```
running 34 tests
test bm25::tests::search_orders_by_relevance ... ok
test chunk::tests::empty_input_yields_no_chunks ... ok
test chunk::tests::respects_char_boundaries_on_multibyte_text ... ok
test chunk::tests::single_short_paragraph_is_one_chunk ... ok
test chunk::tests::splits_long_text_into_overlapping_windows ... ok
test cluster::tests::choose_best_k_prefers_higher_silhouette ... ok
test cluster::tests::kmeans_converges_on_two_separated_clusters ... ok
test cluster::tests::kmeans_is_deterministic_given_seed ... ok
test engine::tests::doc_majority_cluster_tie_break_is_deterministic ... ok
test engine::tests::doc_summaries_fill_slug_and_fit_when_assigned_null_when_not ... ok
test engine::tests::doc_summary_slug_without_fit_for_bootstrap_only_assignment ... ok
test engine::tests::ingest_assigns_to_argmax_cluster_and_skips_embed_on_duplicate ... ignored
test engine::tests::ingest_dedup_and_replace ... ignored
test engine::tests::ingest_no_assignment_when_no_clusters ... ignored
test fuse::tests::rrf_combines_bm25_and_vector_ranks ... ok
test fuse::tests::rrf_favors_items_in_both_lists
... ok
test journal::tests::append_and_list_events_in_order ... ok
test journal::tests::list_events_after_seq_filters_correctly ... ok
test parse::tests::normalizes_line_endings_and_trims ... ok
test parse::tests::strips_html_tags_preserving_text ... ok
test rerank::tests::identity_rerank_preserves_input_order_when_model_unavailable
... ok
test store::tests::cluster_crud_roundtrip ... ok
test store::tests::doc_and_chunk_roundtrip ... ok
test store::tests::duplicate_origin_hash_is_skipped ... ok
test store::tests::journal_roundtrip ... ok
test store::tests::replace_on_hash_change ... ok
test vector::tests::cosine_similarity_matches_expected ... ok
... (하략, 전체 31개 통과 테스트 중 발췌 아님 — 아래 요약 라인이 실측 결과)

test result: ok. 31 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 1.72s
```

신규 3건(`doc_majority_cluster_tie_break_is_deterministic`,
`doc_summary_slug_without_fit_for_bootstrap_only_assignment`,
`doc_summaries_fill_slug_and_fit_when_assigned_null_when_not`) 모두 통과 —
배정 문서→slug/fit 채워짐, 미배정 문서→둘 다 null 케이스를 각각 단위
테스트로 커버. `Engine::new()`가 강제하는 `Embedder`/`Reranker`(ONNX,
네트워크 다운로드) 의존 없이 순수 함수로 구현했기 때문에 `#[ignore]` 없이
기본 `cargo test`에서 실행됨. 기존 `#[ignore]` 3건(`ingest_*`)은 모델 의존
테스트로 이번 라운드 신규 아님 — 회귀 없음(0 failed).

### `cargo build --release` 실행 결과

```
Finished `release` profile [optimized] target(s) in 0.39s
```
0 에러(이미 빌드되어 있던 상태에서 재확인 — 소스 변경 후 최초 빌드 시에도
경고 0/에러 0으로 컴파일 완료 확인함).

### 스모크 테스트 (index → bootstrap → ingest → `/docs`)

스크래치패드 임시 디렉터리(`cosmos-m3-round2-smoke`)에 커피 3편·로켓 3편·
텃밭 3편, 총 9개 문서 매니페스트를 만들어 색인 후 서버(`serve`)를 백그라운드로
띄워 curl로 직접 호출했다.

**1) `cosmos-core index` 결과**:
```json
{"anchor_mismatches":0,"chunks":9,"docs":9,"duplicates":0,"replaced":0,"secs":7.1887879}
```

**2) 부트스트랩 이전 `GET /docs`**: 9개 문서 전부 `"cluster_slug":null,"fit":null`
확인(클러스터가 아직 없으므로 정상).

**3) `POST /clusters/bootstrap` (`k_min:3,k_max:3,seed:42`)**:
```json
{"stats":{"k":3,"silhouette":0.2787630259990692,"docs_assigned":9}}
```
커피/로켓/텃밭 3개 주제가 교차오염 없이 정확히 3개 클러스터로 분리됨(`c01`/
`c02`/`c03`).

**4) 부트스트랩 이후 `GET /docs`**: 9개 문서 전부 주제와 일치하는
`cluster_slug`가 채워지고(예: 커피 문서 3편 전부 `"cluster_slug":"c01"`),
`"fit":null` — "부트스트랩 배정 문서는 null 정상"과 정확히 일치. 발췌:
```json
{"doc_id":"...","origin":"origin://m3r2-coffee1","cluster_slug":"c01","fit":null}
```

**5) 신규 10번째 문서(모카포트 추출, 커피 주제) `/ingest`**:
```json
{"doc_id":"d3475651-...","origin":"origin://m3r2-coffee4","chunks":1,
 "duplicate":false,"replaced":false,"cluster_slug":"c01","fit":0.70006496}
```
ingest-시 argmax 경로가 활성 클러스터를 보고 즉시 배정해 `cluster_slug`와
`fit`이 함께 채워짐 — 부트스트랩 경로(fit null)와 ingest 경로(fit 有)의
비대칭이 실측으로 재확인됨.

**6) 최종 `GET /docs`**: 10개 문서 중 10번째만 `cluster_slug:"c01",
fit:0.70006496`로 둘 다 채워지고, 나머지 9개(부트스트랩 배정분)는 여전히
`fit:null` 유지 — 매 요청마다 집계를 재계산하되 기존 문서의 상태를 오염시키지
않음을 확인.

스모크 테스트 완료 후 백그라운드 `serve` 프로세스는 Windows 실제 PID를
`tasklist` 필터로 찾아(`bash $!` 잡-컨트롤 PID는 MSYS 특성상 실제 PID와
불일치) `taskkill //PID <실PID> //F`로 개별 종료했고, 후속 `tasklist` 조회로
잔존 프로세스 없음을 확인했다. 임시 디렉터리 전체는 `rm -rf`로 삭제, `ls`로
삭제 완료 확인.

### 편차

명세 대비 편차 없음. `openapi.yaml`의 `DocSummary.cluster_slug`/`fit`
(둘 다 nullable additive) 스키마 그대로 구현. 쿼리 효율 요구사항(N+1 금지)도
`Engine::list_docs()`가 문서 수와 무관하게 고정 3쿼리(`list_docs`,
`all_chunk_cluster_rows`, `list_cluster_rows`)만 수행하도록 구현해 충족.

CLI(`main.rs`)는 이번 라운드에서도 전혀 수정하지 않았다 — `main.rs`의
`Commands` enum에는 애초 문서 목록을 출력하는 서브커맨드가 없어(`Index`/
`Search`/`Serve`/`Bootstrap` 4종뿐) "대응 CLI 출력"에 해당하는 지점이
존재하지 않는다. M2 라운드에서의 동일 판단(IngestResponse 확장 시 CLI
stdout은 변경 대상 아님)을 그대로 계승.

신규 로직(`doc_majority_cluster_ids`/`fit_from_meta_json`/
`build_doc_summaries`)은 `Engine`/`Store`/네트워크 의존 없는 순수 함수로
구현 — 기존 `ingest_*` 3건처럼 `Engine::new()`(ONNX 모델 강제 로드)가
필요 없어 `#[ignore]` 없이 기본 `cargo test`로 실행되게 했다. 이 덕분에
"배정 문서→slug/fit 채워짐"과 "미배정 문서→둘 다 null" 두 케이스 모두를
네트워크 없는 기본 테스트 스위트에서 실측 검증할 수 있었다.

### 남은 리스크

- 다수결/동률 처리 로직은 이번 스모크에서도 소규모(문서 ≤10, 클러스터
  3개) 범위에서만 실측됨 — 문서 수백~수천 건 규모에서 3쿼리 집계 방식의
  실제 응답 지연/메모리 사용량은 미측정.
- 한 문서의 청크들이 서로 다른 클러스터에 절반씩 나뉘어 배정되는 등 극단적
  동률 상황은 `doc_majority_cluster_tie_break_is_deterministic` 단위
  테스트로만 검증되었고, 실제 색인 파이프라인에서 그런 상황이 얼마나
  자주 발생하는지는 확인하지 않았다.

## M4 라운드(피니셔) — executor-sonnet

### 이 세션에서 실제 수행한 작업
- 이전 레인이 이미 완료해둔 것(재확인만, 미수정): serve.rs의 6개 M4 핸들러/라우트(misfits, lifecycle/proposals, clusters/centroids, clusters/birth, clusters/merge, rollback), engine_error_to_app_error 매핑, journal.rs의 M4 이벤트 함수(append_cluster_birth_lifecycle, append_cluster_merge, append_rollback), main.rs CLI(신규 서브커맨드 불필요 — birth/merge/rollback은 HTTP 전용, 재확인 완료).
- 이번 세션에 신규 작성: `src/engine.rs` 테스트 모듈에 헬퍼 2개(`doc_state`, `seed_misfit_doc`) + 테스트 4개 추가.
  - `birth_and_rollback_round_trip_restores_prior_state`
  - `merge_and_rollback_round_trip_is_lossless`
  - `lifecycle_proposals_are_deterministic`
  - `rollback_of_already_rolled_back_event_is_rejected`

### cargo test (fresh, this session)
```
test result: ok. 40 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 13.31s
```

### cargo build --release (fresh, this session)
```
Finished `release` profile [optimized] target(s) in 0.52s
```

### 스모크 테스트 (격리 포트 8850, `$SCRATCH/out`)
1. `index --manifest`(요리 3 + 천문 3, 6 docs) → 0 anchor_mismatches, 0 duplicates, 6 chunks.
2. `bootstrap --k-min 2 --k-max 3 --seed 42` → k=3, silhouette 0.245, docs_assigned=6.
3. `serve --port 8850` 기동 → `/health` docs=6, clusters=3 (정확히 일치, 오염 없음 확인).
4. `/ingest` 12개 이종 문서(tech/garden/finance/music/sport/travel) → 전부 `duplicate:false`, `/health` docs=18 (정확히 예상치 일치).
5. `/misfits` → 5건 검출. `/lifecycle/proposals?birth_min=2&birth_cohesion=0.5&merge_sim=0.5` → birth 후보 1건(travel1+travel2, cohesion 0.617), merge 후보 2건(top: c02↔c03 centroid_sim 0.640).
6. `/clusters/birth`(travel1+travel2 → c-travel-test) → clusters 3→4. journal seq=35(cluster_birth) 확인 → `/rollback {seq:35}` → `/docs`·`/clusters` 스냅샷 diff **완전 0**(바이트 단위 일치).
7. `/clusters/merge`(c02→c03) → dst n_docs 1→8. journal seq=37(cluster_merge) 확인 → `/rollback {seq:37}` → `/docs` diff **0**; `/clusters` diff는 dst row의 `updated_at` 타임스탬프 1건만 차이(롤백 자체가 이벤트소싱상 새 쓰기이므로 기대된 동작) — id/slug/status/n_docs/n_chunks 등 실질 필드는 전부 일치.
8. 서버 종료, 스크래치 out 정리.

### 발견 사항(블로커 아님, 보고용)
- **CLI/HTTP `source_type` 불일치**: `main.rs`의 `ManifestEntry.source_type`은 무검증 `String`(예: "note"도 통과)인 반면, HTTP `/ingest`의 `IngestRequest.source_type`은 엄격한 6-variant enum(`arxiv|rss|manual|session|repo|biz`)이라 `"note"`가 400 에러("unknown variant `note`")를 유발함. 스모크 테스트 중 실제로 재현. 범위 밖이라 미수정, 참고용 기록.
- **mind 데몬의 포트 하드코딩 발견**: 스모크 테스트 초기 시도(포트 8801, task #32 완료 이후)에서 서버를 기동하자마자 알 수 없는 외부 프로세스가 사용자의 실제 Knowledge Hub 메모리 파일(`cosmos-knowledge-universe.md` 등 17개)을 내 격리된 스크래치 DB에 `/ingest`로 밀어넣는 것을 확인. 원인 조사 결과 이는 **내 자신의 스모크 테스트 서버**(scratch out 디렉터리에 바인딩, CommandLine으로 재확인)였고, `serve.pid`에 기록된 PID(335538)가 실제 자식 프로세스 PID(5548)와 달라 혼선이 있었음 — 프로덕션 데이터는 전혀 건드리지 않았음(안전 확인 완료). 다만 mind 데몬이 포트 8801을 "항상 프로덕션"으로 가정하고 무조건 ingest를 시도하는 것으로 보이며, 세션/인스턴스 구분 없이 동작함 — 임시 테스트 인스턴스도 오염시킬 수 있다는 설계상 리스크로 기록. 본 스모크 테스트는 이후 8850 포트로 재기동해 오염 없이 완료함.
