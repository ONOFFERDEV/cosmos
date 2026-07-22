// 클러스터 부트스트랩: core POST /clusters/bootstrap 호출 → 각 클러스터를 sample로부터
// LLM 라벨링(slug/name/description) → PATCH /clusters/{id} → 결과 표 출력.
// CONTRACT.md M1 확장 절 "bootstrap" 참고. slug 충돌 시 -2, -3... 접미사를 붙인다.

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

/** 영문 kebab-case로 정규화한다. 결과가 비면 "cluster"로 대체한다. */
export function sanitizeSlug(raw: string): string {
  const s = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "cluster";
}

/** 이미 사용된 slug와 겹치면 -2, -3... 접미사를 붙여 유일하게 만든다. 순수 함수 — used를 변경. */
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
    // M9: 개인 클러스터는 LLM 리라벨 후에도 p-<owner>- 접두를 유지해
    // 공통 슬러그와 절대 충돌하지 않게 한다.
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
