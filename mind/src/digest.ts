// Cluster digest generator: generates a per-cluster summary via LLM and stores it in core.
// See CONTRACT.md "mind: 다이제스트 생성" section.
// Regeneration conditions: digest absent / member n_docs differs from last generation / opts.all=true (force all).
// The n_docs snapshot is stored in data/digest.state.json (tracked on the mind side without a core schema change).
// A single LLM call failure skips only that cluster and the rest continue (isolation, same pattern as lifecycle.ts's candidate handling).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { CoreClient, ClusterSummary, DocSummary } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { defaultDataDir } from "./config.js";

export interface DigestDeps {
  core: CoreClient;
  llm: LlmClient;
  dataDir?: string;
  /** M9: list of ownership scopes to iterate. Defaults to ["shared", "shared+admin"]. */
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
  // A digest exists but there's no snapshot (e.g. state file lost) -> we can't tell if it changed,
  // so we conservatively keep it (avoids wasting an LLM call on an unnecessary regeneration).
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

  // M9: gathers and iterates clusters/digests/docs per scope (personal clusters are only visible in the owner's scope).
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
      // LLM/save failure skips only this cluster — the rest continue (isolation).
      outcomes.push({ cluster_id: cluster.id, slug: cluster.slug, status: "failed", error: (err as Error).message });
      failed++;
    }
  }

  await saveState(dataDir, state);

  return { generated, skipped, failed, outcomes };
}
