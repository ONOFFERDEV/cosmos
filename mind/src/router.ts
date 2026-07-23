// Cluster routing: from the centroid_sim/bm25_hits returned by core /route, decides which
// clusters to "consult" and which to "skip".
// CONTRACT.md M1 extension section: score = centroid_sim + 0.02*min(bm25_hits,10), sort
// descending, take the top K=3 as consulted candidates, but demote any of them with
// score < 0.6*top_score to skipped even if within K. Everything else is skipped.

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
 * Computes the consulted/skipped decision and trace reason from RouteScore[] (the core /route response).
 * Pure function -- no I/O.
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
