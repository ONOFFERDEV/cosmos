import { test } from "node:test";
import assert from "node:assert/strict";
import {
  originsOf,
  clustersOfSources,
  judgeMultiClusterCitation,
  judgeNewSourceRecovery,
  judgeTraceCompleteness,
  judgeNegativeInsufficient,
} from "./judge_deep.mjs";

test("originsOf: sources[]에서 origin만 순서대로 추출", () => {
  const sources = [{ origin: "a.md" }, { origin: "b.md" }];
  assert.deepEqual(originsOf(sources), ["a.md", "b.md"]);
  assert.deepEqual(originsOf([]), []);
  assert.deepEqual(originsOf(undefined), []);
});

test("clustersOfSources: 매핑에 있는 origin만 클러스터 슬러그로 모음(미매핑은 무시)", () => {
  const sources = [{ origin: "a.md" }, { origin: "b.md" }, { origin: "unknown.md" }];
  const map = { "a.md": "cluster-x", "b.md": "cluster-y" };
  const clusters = clustersOfSources(sources, map);
  assert.deepEqual([...clusters].sort(), ["cluster-x", "cluster-y"]);
});

test("judgeMultiClusterCitation: 서로 다른 클러스터 2개 인용 시 PASS", () => {
  const sources = [{ origin: "a.md" }, { origin: "b.md" }];
  const map = { "a.md": "cluster-x", "b.md": "cluster-y" };
  const result = judgeMultiClusterCitation(sources, map);
  assert.equal(result.pass, true);
  assert.deepEqual(result.clusters.sort(), ["cluster-x", "cluster-y"]);
});

test("judgeMultiClusterCitation: 클러스터 1개만 인용 시 FAIL", () => {
  const sources = [{ origin: "a.md" }, { origin: "a2.md" }];
  const map = { "a.md": "cluster-x", "a2.md": "cluster-x" };
  const result = judgeMultiClusterCitation(sources, map);
  assert.equal(result.pass, false);
  assert.match(result.reason, /1개/);
});

test("judgeMultiClusterCitation: 맵에 전혀 매핑되지 않으면 0개로 FAIL", () => {
  const sources = [{ origin: "unknown1.md" }, { origin: "unknown2.md" }];
  const result = judgeMultiClusterCitation(sources, {});
  assert.equal(result.pass, false);
  assert.equal(result.clusters.length, 0);
});

test("judgeNewSourceRecovery: deep이 fast에 없던 origin을 회수하면 PASS", () => {
  const fastSources = [{ origin: "a.md" }];
  const deepSources = [{ origin: "a.md" }, { origin: "new.md" }];
  const result = judgeNewSourceRecovery(fastSources, deepSources);
  assert.equal(result.pass, true);
  assert.deepEqual(result.newOrigins, ["new.md"]);
});

test("judgeNewSourceRecovery: deep 출처가 fast의 부분집합이면 FAIL", () => {
  const fastSources = [{ origin: "a.md" }, { origin: "b.md" }];
  const deepSources = [{ origin: "a.md" }];
  const result = judgeNewSourceRecovery(fastSources, deepSources);
  assert.equal(result.pass, false);
  assert.deepEqual(result.newOrigins, []);
});

test("judgeNewSourceRecovery: 신규 출처 중복은 한 번만 집계", () => {
  const fastSources = [{ origin: "a.md" }];
  const deepSources = [{ origin: "new.md" }, { origin: "new.md" }, { origin: "a.md" }];
  const result = judgeNewSourceRecovery(fastSources, deepSources);
  assert.equal(result.pass, true);
  assert.deepEqual(result.newOrigins, ["new.md"]);
});

test("judgeTraceCompleteness: 전 active 클러스터가 consulted/skipped로 정상 등장하면 PASS", () => {
  const trace = [
    { cluster: "cluster-x", action: "consulted", subquestion: "x 관점에서는?" },
    { cluster: "cluster-y", action: "skipped", why: "예산 컷" },
  ];
  const result = judgeTraceCompleteness(trace, ["cluster-x", "cluster-y"]);
  assert.equal(result.pass, true);
});

test("judgeTraceCompleteness: 클러스터가 trace에서 통째로 빠지면 FAIL", () => {
  const trace = [{ cluster: "cluster-x", action: "consulted", subquestion: "q" }];
  const result = judgeTraceCompleteness(trace, ["cluster-x", "cluster-y"]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.missing, ["cluster-y"]);
});

test("judgeTraceCompleteness: consulted인데 subquestion이 빈 문자열이면 FAIL", () => {
  const trace = [{ cluster: "cluster-x", action: "consulted", subquestion: "  " }];
  const result = judgeTraceCompleteness(trace, ["cluster-x"]);
  assert.equal(result.pass, false);
  assert.equal(result.malformed.length, 1);
});

test("judgeTraceCompleteness: skipped인데 why가 없으면 FAIL", () => {
  const trace = [{ cluster: "cluster-x", action: "skipped" }];
  const result = judgeTraceCompleteness(trace, ["cluster-x"]);
  assert.equal(result.pass, false);
  assert.match(result.malformed[0], /why 없음/);
});

test("judgeNegativeInsufficient: insufficient === true면 PASS", () => {
  const result = judgeNegativeInsufficient({ insufficient: true });
  assert.equal(result.pass, true);
});

test("judgeNegativeInsufficient: insufficient === false면 FAIL", () => {
  const result = judgeNegativeInsufficient({ insufficient: false });
  assert.equal(result.pass, false);
});

test("judgeNegativeInsufficient: insufficient 필드 자체가 없으면 FAIL", () => {
  const result = judgeNegativeInsufficient({});
  assert.equal(result.pass, false);
});
