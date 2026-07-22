// Cosmos M3 deep 협의 모드 A/B 게이트 평가용 순수 판정 함수 모음.
// eval_deep.mjs(실행)와 judge_deep.test.mjs(자가검증)가 공유한다.
// 판정 대상 스키마는 contract/CONTRACT.md "# M3 확장"의 deep envelope·"M3 게이트(A/B)"를 따른다.
//
// 클러스터 매핑 방법(기준1에 필요): M3 게이트 2차 실측 후 core GET /docs가 origin별 cluster_slug를
// 직접 노출하도록 확장됐다(openapi.yaml DocSummary, 청크 cluster_ids 기준 배정). eval_deep.mjs의
// buildOriginClusterMap이 GET /docs를 그대로 읽어 origin -> cluster_slug 딕셔너리를 만든다(근사 없음,
// cluster_slug가 null인 문서만 제외). 아래 순수 함수들은 이미 만들어진 맵을 입력으로만 받아 판정한다.

/** sources[] 배열에서 origin 목록만 뽑는다(순서 보존, 중복 제거는 호출자 책임). */
export function originsOf(sources) {
  return (sources ?? []).map((s) => s.origin);
}

/** sources[]를 originClusterMap(origin -> cluster_slug)으로 매핑해 등장한 클러스터 슬러그 Set을 반환.
 * 맵에 없는 origin(근사 실패분 또는 미매핑 문서)은 조용히 무시한다. */
export function clustersOfSources(sources, originClusterMap) {
  const set = new Set();
  for (const s of sources ?? []) {
    const slug = originClusterMap?.[s.origin];
    if (slug) set.add(slug);
  }
  return set;
}

// 게이트 기준1: deep 출처가 서로 다른 클러스터 >= 2개를 인용해야 한다.
export function judgeMultiClusterCitation(deepSources, originClusterMap) {
  const clusters = clustersOfSources(deepSources, originClusterMap);
  if (clusters.size < 2) {
    return {
      pass: false,
      reason: `deep 출처 클러스터 ${clusters.size}개(<2): [${[...clusters].join(", ")}]`,
      clusters: [...clusters],
    };
  }
  return { pass: true, reason: "", clusters: [...clusters] };
}

// 게이트 기준2: deep이 fast가 인용하지 못한 출처 문서를 >= 1건 새로 회수해야 한다.
export function judgeNewSourceRecovery(fastSources, deepSources) {
  const fastOrigins = new Set(originsOf(fastSources));
  const newOrigins = [...new Set(originsOf(deepSources))].filter((o) => !fastOrigins.has(o));
  if (newOrigins.length === 0) {
    return { pass: false, reason: "deep이 fast 대비 신규 회수 출처 0건", newOrigins: [] };
  }
  return { pass: true, reason: "", newOrigins };
}

// 게이트 기준3: 전 active 클러스터가 trace에 consulted(subquestion 포함) 또는
// skipped(비어있지 않은 why 포함)로 등장해야 한다.
export function judgeTraceCompleteness(trace, activeClusterSlugs) {
  const list = trace ?? [];
  const missing = [];
  const malformed = [];
  for (const slug of activeClusterSlugs ?? []) {
    const entry = list.find((t) => t.cluster === slug);
    if (!entry) {
      missing.push(slug);
      continue;
    }
    if (entry.action === "consulted") {
      if (!entry.subquestion || String(entry.subquestion).trim() === "") {
        malformed.push(`${slug}: consulted인데 subquestion 없음`);
      }
    } else if (entry.action === "skipped") {
      if (!entry.why || String(entry.why).trim() === "") {
        malformed.push(`${slug}: skipped인데 why 없음`);
      }
    } else {
      malformed.push(`${slug}: action이 consulted/skipped가 아님(${entry.action})`);
    }
  }
  const reasons = [];
  if (missing.length > 0) reasons.push(`trace 누락 클러스터: ${missing.join(", ")}`);
  if (malformed.length > 0) reasons.push(malformed.join("; "));
  return { pass: reasons.length === 0, reason: reasons.join(" | "), missing, malformed };
}

// 부정 문항: deep도 insufficient === true여야 한다(코퍼스 밖 질문 차단 확인).
export function judgeNegativeInsufficient(envelope) {
  if (envelope?.insufficient !== true) {
    return { pass: false, reason: `insufficient !== true (실제: ${JSON.stringify(envelope?.insufficient)})` };
  }
  return { pass: true, reason: "" };
}
