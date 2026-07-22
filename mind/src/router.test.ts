import { test } from "node:test";
import assert from "node:assert/strict";

import { computeRouteScore, decideRoutes, consultedClusterIds } from "./router.js";
import type { RouteScore } from "./core-client.js";

function score(cluster_id: string, centroid_sim: number, bm25_hits = 0): RouteScore {
  return { cluster_id, slug: cluster_id, centroid_sim, bm25_hits };
}

test("빈 입력이면 빈 배열을 반환한다", () => {
  assert.deepEqual(decideRoutes([]), []);
});

test("computeRouteScore는 bm25_hits를 10으로 캡하고 0.02 가중치를 곱한다", () => {
  assert.equal(computeRouteScore(0.5, 3), 0.5 + 0.02 * 3);
  assert.equal(computeRouteScore(0.5, 100), 0.5 + 0.02 * 10);
});

test("상위 K=3은 consulted, 그 밖 순위는 top K 밖 사유로 skipped", () => {
  const scores = [score("a", 1.0), score("b", 0.9), score("c", 0.8), score("d", 0.75), score("e", 0.7)];
  const decisions = decideRoutes(scores);
  assert.equal(decisions.length, 5);
  assert.deepEqual(
    decisions.slice(0, 3).map((d) => d.action),
    ["consulted", "consulted", "consulted"]
  );
  assert.deepEqual(
    decisions.slice(3).map((d) => d.action),
    ["skipped", "skipped"]
  );
  assert.match(decisions[3]!.why, /top 3 밖/);
  assert.match(decisions[4]!.why, /top 3 밖/);
});

test("상위 K 이내라도 score < 0.6*top이면 skipped로 강등한다", () => {
  const scores = [score("a", 1.0), score("b", 0.59)];
  const decisions = decideRoutes(scores);
  assert.equal(decisions[0]!.action, "consulted");
  assert.equal(decisions[1]!.action, "skipped");
  assert.match(decisions[1]!.why, /< 0\.6·top/);
});

test("정확히 0.6*top 경계값은 consulted로 처리한다 (>=)", () => {
  const scores = [score("a", 1.0), score("b", 0.6)];
  const decisions = decideRoutes(scores);
  assert.equal(decisions[1]!.action, "consulted");
  assert.match(decisions[1]!.why, /rank 2/);
});

test("consultedClusterIds는 consulted 항목의 cluster_id만 추출한다", () => {
  const scores = [score("a", 1.0), score("b", 0.59), score("c", 0.5)];
  const ids = consultedClusterIds(decideRoutes(scores));
  assert.deepEqual(ids, ["a"]);
});
