// Cluster bootstrap: calls core POST /clusters/bootstrap → LLM-labels each cluster
// from its sample (slug/name/description) → PATCH /clusters/{id} → prints the result table.
// See CONTRACT.md M1 확장 section, "bootstrap". Slug collisions get a -2, -3, ... suffix.

import type { CoreClient, ClusterBootstrapResult, BootstrapOptions } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { completeJson } from "./llm.js";

export interface BootstrapDeps {
  core: CoreClient;
  llm: LlmClient;
}

export interface ClusterLabel {
  slug: string;
  name: string;
  description: string;
}

interface LlmLabelResponse {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
}

export interface BootstrapRunResult {
  cluster_id: string;
  before_slug: string;
  slug: string;
  name: string;
  description: string;
}

/** Normalizes to English kebab-case. Falls back to "cluster" if the result is empty. */
export function sanitizeSlug(raw: string): string {
  const s = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "cluster";
}

/** If it collides with an already-used slug, appends a -2, -3... suffix to make it unique. Pure function — mutates used. */
export function dedupSlug(slug: string, used: Set<string>): string {
  if (!used.has(slug)) {
    used.add(slug);
    return slug;
  }
  let n = 2;
  let candidate = `${slug}-${n}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${slug}-${n}`;
  }
  used.add(candidate);
  return candidate;
}

export function buildLabelPrompt(cluster: ClusterBootstrapResult): string {
  const sampleText = cluster.sample
    .map((s, i) => {
      const titlePart = s.title ? ` (${s.title})` : "";
      const snippetPart = s.snippet ? `\n   발췌: ${s.snippet}` : "";
      return `${i + 1}. 출처: ${s.origin}${titlePart}${snippetPart}`;
    })
    .join("\n");

  return `다음은 문서 클러스터링 결과로 묶인 문서 표본입니다. 이 클러스터에 이름을 붙여주세요.

문서 표본:
${sampleText || "(표본 없음)"}

다음 JSON 형식으로만 답하세요 (설명이나 마크다운 없이 순수 JSON 객체 하나만):
{"slug": "영문 kebab-case 식별자", "name": "한국어 클러스터 이름", "description": "한국어 한 문장 설명"}`;
}

export async function labelCluster(
  cluster: ClusterBootstrapResult,
  llm: LlmClient
): Promise<ClusterLabel> {
  const prompt = buildLabelPrompt(cluster);
  const response = await completeJson<LlmLabelResponse>(llm, prompt);

  const slug =
    typeof response.slug === "string" && response.slug.trim()
      ? sanitizeSlug(response.slug)
      : sanitizeSlug(cluster.slug);
  const name =
    typeof response.name === "string" && response.name.trim() ? response.name.trim() : cluster.slug;
  const description = typeof response.description === "string" ? response.description.trim() : "";

  return { slug, name, description };
}

export async function runBootstrap(
  deps: BootstrapDeps,
  options: BootstrapOptions = {}
): Promise<BootstrapRunResult[]> {
  const bootstrapResponse = await deps.core.bootstrapClusters(options);
  const usedSlugs = new Set<string>();
  const results: BootstrapRunResult[] = [];

  for (const cluster of bootstrapResponse.clusters) {
    const label = await labelCluster(cluster, deps.llm);
    // M9: personal clusters keep the p-<owner>- prefix even after LLM relabeling,
    // so they never collide with common/shared slugs.
    const scopedSlug = cluster.owner ? `p-${cluster.owner}-${label.slug}` : label.slug;
    const finalSlug = dedupSlug(scopedSlug, usedSlugs);

    const updated = await deps.core.updateCluster(cluster.id, {
      slug: finalSlug,
      name: label.name,
      description: label.description,
    });

    results.push({
      cluster_id: cluster.id,
      before_slug: cluster.slug,
      slug: updated.slug,
      name: updated.name ?? label.name,
      description: updated.description ?? label.description,
    });
  }

  printResultTable(results);
  return results;
}

function printResultTable(results: BootstrapRunResult[]): void {
  console.log(`클러스터 부트스트랩 완료: ${results.length}개`);
  for (const r of results) {
    console.log(`  [${r.cluster_id}] ${r.before_slug} -> ${r.slug} | ${r.name} — ${r.description}`);
  }
}
