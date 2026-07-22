// 클러스터 다이제스트 생성기: 클러스터별 요약을 LLM으로 생성해 core에 저장한다.
// CONTRACT.md "mind: 다이제스트 생성" 절 참고.
// 재생성 조건: 다이제스트 부재 / 멤버 n_docs가 마지막 생성 시점과 다름 / opts.all=true(강제 전체).
// n_docs 스냅샷은 data/digest.state.json에 저장한다(core 스키마 변경 없이 mind 측에서 추적).
// LLM 호출 하나의 실패는 그 클러스터만 건너뛰고 나머지는 계속 진행한다(격리, lifecycle.ts의 후보 처리와 동일 패턴).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { CoreClient, ClusterSummary, DocSummary } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { defaultDataDir } from "./config.js";

export interface DigestDeps {
  core: CoreClient;
  llm: LlmClient;
  dataDir?: string;
  /** M9: 순회할 소유권 스코프 목록. 기본 ["shared", "shared+admin"]. */
  scopes?: string[];
}

export interface DigestOutcome {
  cluster_id: string;
  slug: string;
  status: "generated" | "skipped" | "failed";
  error?: string;
}

export interface DigestRunResult {
  generated: number;
  skipped: number;
  failed: number;
  outcomes: DigestOutcome[];
}

interface DigestState {
  n_docs: Record<string, number>;
}

async function loadState(dataDir: string): Promise<DigestState> {
  try {
    const raw = await readFile(path.join(dataDir, "digest.state.json"), "utf8");
    return JSON.parse(raw) as DigestState;
  } catch {
    return { n_docs: {} };
  }
}

async function saveState(dataDir: string, state: DigestState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "digest.state.json"), JSON.stringify(state, null, 2), "utf8");
}

function needsRegeneration(
  hasDigest: boolean,
  currentNDocs: number,
  lastNDocs: number | undefined,
  all: boolean
): boolean {
  if (all) return true;
  if (!hasDigest) return true;
  // 다이제스트는 있지만 스냅샷이 없다(예: 상태 파일 소실) -> 변경 여부를 알 수 없으니
  // 보수적으로 유지한다(불필요한 재생성으로 LLM 호출을 낭비하지 않는다).
  if (lastNDocs === undefined) return false;
  return lastNDocs !== currentNDocs;
}

function buildDigestPrompt(cluster: ClusterSummary, memberDocs: DocSummary[]): string {
  const docLines = memberDocs
    .slice(0, 30)
    .map((d, i) => `${i + 1}. ${d.title ?? "(제목 없음)"} (${d.origin})`)
    .join("\n");

  return `다음은 지식 클러스터 하나의 정보입니다. 이 클러스터의 다이제스트(요약)를 작성하세요.

클러스터: ${cluster.name ?? cluster.slug} (slug: ${cluster.slug})
설명: ${cluster.description ?? "(설명 없음)"}
문서 수: ${cluster.n_docs}건, 청크 수: ${cluster.n_chunks}건

멤버 문서 목록 (제목만, 최대 30건 표본):
${docLines || "(문서 없음)"}

한국어로 300~600자 분량의 다이제스트를 작성하세요. 다음을 포함하세요:
- 이 클러스터가 다루는 주제 요약
- 대표 문서 제목 몇 개 언급
- 최근 갱신 동향(문서 수 등)

설명이나 마크다운 없이 순수 텍스트만 출력하세요.`;
}

export async function generateDigests(deps: DigestDeps, opts: { all?: boolean } = {}): Promise<DigestRunResult> {
  const all = !!opts.all;
  const dataDir = deps.dataDir ?? defaultDataDir();
  const state = await loadState(dataDir);

  // M9: 스코프별로 클러스터·다이제스트·문서를 모아 순회한다(개인 클러스터는 소유자 스코프에서만 보임).
  const scopes = deps.scopes ?? ["shared", "shared+admin"];
  const perScope = await Promise.all(
    scopes.map((scope) =>
      Promise.all([
        deps.core.listClusters(scope),
        deps.core.listClusterDigests(scope),
        deps.core.listDocs(scope),
      ])
    )
  );
  const seenClusterIds = new Set<string>();
  const clusters = [] as Awaited<ReturnType<CoreClient["listClusters"]>>;
  const existingDigests = [] as Awaited<ReturnType<CoreClient["listClusterDigests"]>>;
  const docs = [] as Awaited<ReturnType<CoreClient["listDocs"]>>;
  const seenDigestClusters = new Set<string>();
  const seenDocIds = new Set<string>();
  for (const [scopeClusters, scopeDigests, scopeDocs] of perScope) {
    for (const c of scopeClusters) if (!seenClusterIds.has(c.id)) { seenClusterIds.add(c.id); clusters.push(c); }
    for (const d of scopeDigests) if (!seenDigestClusters.has(d.cluster_id)) { seenDigestClusters.add(d.cluster_id); existingDigests.push(d); }
    for (const doc of scopeDocs) if (!seenDocIds.has(doc.doc_id)) { seenDocIds.add(doc.doc_id); docs.push(doc); }
  }

  const activeClusters = clusters.filter((c) => c.status === "active");
  const digestClusterIds = new Set(existingDigests.map((d) => d.cluster_id));

  const outcomes: DigestOutcome[] = [];
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const cluster of activeClusters) {
    const hasDigest = digestClusterIds.has(cluster.id);
    const lastNDocs = state.n_docs[cluster.id];

    if (!needsRegeneration(hasDigest, cluster.n_docs, lastNDocs, all)) {
      outcomes.push({ cluster_id: cluster.id, slug: cluster.slug, status: "skipped" });
      skipped++;
      continue;
    }

    try {
      const memberDocs = docs.filter((d) => d.cluster_slug === cluster.slug);
      const prompt = buildDigestPrompt(cluster, memberDocs);
      const text = (await deps.llm.complete(prompt, "sonnet")).trim();
      await deps.core.putClusterDigest(cluster.id, text, "sonnet");
      state.n_docs[cluster.id] = cluster.n_docs;
      outcomes.push({ cluster_id: cluster.id, slug: cluster.slug, status: "generated" });
      generated++;
    } catch (err) {
      // LLM/저장 실패는 이 클러스터만 건너뛴다 — 나머지 클러스터는 계속 진행(격리).
      outcomes.push({ cluster_id: cluster.id, slug: cluster.slug, status: "failed", error: (err as Error).message });
      failed++;
    }
  }

  await saveState(dataDir, state);

  return { generated, skipped, failed, outcomes };
}
