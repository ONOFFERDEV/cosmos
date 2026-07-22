// 클러스터 라우팅: core /route가 돌려주는 centroid_sim/bm25_hits로부터
// 어떤 클러스터를 "참고(consulted)"하고 어떤 클러스터를 "건너뛸지(skipped)" 결정한다.
// CONTRACT.md M1 확장 절: score = centroid_sim + 0.02*min(bm25_hits,10),
// 내림차순 정렬 후 상위 K=3을 consulted 후보로 삼되, 그중 score < 0.6*top_score인
// 것은 K 안에 있어도 skipped로 강등한다. 나머지는 전부 skipped.

import type { RouteScore } from "./core-client.js";

export const ROUTING_K = 3;
export const ROUTING_BM25_WEIGHT = 0.02;
export const ROUTING_BM25_CAP = 10;
export const ROUTING_RELATIVE_THRESHOLD = 0.6;

export interface RouteDecision {
  cluster_id: string;
  slug: string;
  score: number;
  action: "consulted" | "skipped";
  why: string;
}

export function computeRouteScore(centroidSim: number, bm25Hits: number): number {
  return centroidSim + ROUTING_BM25_WEIGHT * Math.min(bm25Hits, ROUTING_BM25_CAP);
}

/**
 * RouteScore[] (core /route 응답)로부터 consulted/skipped 결정과 trace용 사유를 계산한다.
 * 순수 함수 — I/O 없음.
 */
export function decideRoutes(scores: RouteScore[]): RouteDecision[] {
  if (scores.length === 0) {
    return [];
  }

  const scored = scores.map((s) => ({
    cluster_id: s.cluster_id,
    slug: s.slug,
    score: computeRouteScore(s.centroid_sim, s.bm25_hits),
  }));

  scored.sort((a, b) => b.score - a.score);

  const topScore = scored[0]!.score;
  const threshold = ROUTING_RELATIVE_THRESHOLD * topScore;

  return scored.map((entry, index) => {
    const rank = index + 1;
    const withinTopK = index < ROUTING_K;
    const meetsThreshold = entry.score >= threshold;

    if (withinTopK && meetsThreshold) {
      return {
        cluster_id: entry.cluster_id,
        slug: entry.slug,
        score: entry.score,
        action: "consulted",
        why: `score ${entry.score.toFixed(2)} (rank ${rank})`,
      };
    }

    const why = withinTopK
      ? `${entry.score.toFixed(2)} < 0.6·top`
      : `score ${entry.score.toFixed(2)} (rank ${rank}) — top ${ROUTING_K} 밖`;

    return {
      cluster_id: entry.cluster_id,
      slug: entry.slug,
      score: entry.score,
      action: "skipped",
      why,
    };
  });
}

export function consultedClusterIds(decisions: RouteDecision[]): string[] {
  return decisions.filter((d) => d.action === "consulted").map((d) => d.cluster_id);
}
