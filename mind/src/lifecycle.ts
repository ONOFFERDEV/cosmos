// 클러스터 생명주기 데몬: core GET /lifecycle/proposals의 탄생/병합 후보를 처리한다.
// CONTRACT.md "# M4 확장" 절 "lifecycle" 참고.
// - 탄생 후보: bootstrap.ts와 동일한 방식으로 LLM 라벨링(slug/name/description) 후 POST /clusters/birth.
//   후보 하나의 라벨링 실패는 그 후보만 건너뛰고 나머지는 정상 진행한다(격리).
// - 병합 후보: 같은 쌍이 "연속 2회" 관측되어야만 실제 POST /clusters/merge를 호출한다(히스테리시스).
//   관측 상태는 data/lifecycle.state.json에 저장. --dry-run은 상태 파일에 쓰지 않는다(부작용 없음).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  CoreClient,
  BirthProposal,
  MergeProposal,
  LifecycleProposalsResponse,
} from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { completeJson } from "./llm.js";
import { sanitizeSlug, dedupSlug } from "./bootstrap.js";
import { defaultDataDir, type LifecycleConfig } from "./config.js";
import { generateDigests } from "./digest.js";

export interface LifecycleDeps {
  core: CoreClient;
  llm: LlmClient;
  config: LifecycleConfig;
  dataDir?: string;
}

export interface LifecycleState {
  merge_streaks: Record<string, number>;
}

export interface BirthOutcome {
  doc_ids: string[];
  slug: string | null;
  name: string | null;
  description: string | null;
  status: "created" | "dry_run" | "naming_failed";
  error?: string;
}

export interface MergeOutcome extends MergeProposal {
  streak: number;
  status: "observed" | "merged" | "dry_run_would_merge";
}

export interface LifecycleRunResult {
  births: BirthOutcome[];
  merges: MergeOutcome[];
  dry_run: boolean;
}

export interface MergeStatusEntry extends MergeProposal {
  streak: number;
  would_trigger_next_run: boolean;
}

export interface LifecycleStatusResult {
  births_pending: number;
  merges: MergeStatusEntry[];
}

interface LifecycleLlmLabelResponse {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
}

/** 병합 후보 쌍의 순서에 무관하게 동일한 키를 만든다(core가 a/b 순서를 매 호출 보장하지 않을 수 있음). */
function mergeKey(aId: string, bId: string): string {
  return [aId, bId].sort().join("::");
}

async function loadState(dataDir: string): Promise<LifecycleState> {
  try {
    const raw = await readFile(path.join(dataDir, "lifecycle.state.json"), "utf8");
    return JSON.parse(raw) as LifecycleState;
  } catch {
    return { merge_streaks: {} };
  }
}

async function saveState(dataDir: string, state: LifecycleState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "lifecycle.state.json"), JSON.stringify(state, null, 2), "utf8");
}

function buildBirthLabelPrompt(proposal: BirthProposal): string {
  const sampleText = proposal.sample_titles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `다음은 아직 이름이 없는 새 문서 클러스터 후보입니다. 이 클러스터에 이름을 붙여주세요.

문서 제목 표본 (총 ${proposal.doc_ids.length}건 중 일부):
${sampleText || "(표본 없음)"}

다음 JSON 형식으로만 답하세요 (설명이나 마크다운 없이 순수 JSON 객체 하나만):
{"slug": "영문 kebab-case 식별자", "name": "한국어 클러스터 이름", "description": "한국어 한 문장 설명"}`;
}

interface BirthLabel {
  slug: string;
  name: string;
  description: string;
}

async function labelBirthProposal(proposal: BirthProposal, llm: LlmClient): Promise<BirthLabel> {
  const prompt = buildBirthLabelPrompt(proposal);
  const response = await completeJson<LifecycleLlmLabelResponse>(llm, prompt);
  const fallback = proposal.sample_titles[0] ?? "cluster";

  const slug =
    typeof response.slug === "string" && response.slug.trim() ? sanitizeSlug(response.slug) : sanitizeSlug(fallback);
  const name = typeof response.name === "string" && response.name.trim() ? response.name.trim() : fallback;
  const description = typeof response.description === "string" ? response.description.trim() : "";

  return { slug, name, description };
}

async function processBirths(
  proposals: BirthProposal[],
  deps: LifecycleDeps,
  dryRun: boolean
): Promise<BirthOutcome[]> {
  const outcomes: BirthOutcome[] = [];
  const usedSlugs = new Set<string>();

  for (const proposal of proposals) {
    try {
      const label = await labelBirthProposal(proposal, deps.llm);
      const slug = dedupSlug(label.slug, usedSlugs);

      if (dryRun) {
        outcomes.push({
          doc_ids: proposal.doc_ids,
          slug,
          name: label.name,
          description: label.description,
          status: "dry_run",
        });
        continue;
      }

      await deps.core.birthCluster({
        doc_ids: proposal.doc_ids,
        slug,
        name: label.name,
        description: label.description,
      });
      outcomes.push({
        doc_ids: proposal.doc_ids,
        slug,
        name: label.name,
        description: label.description,
        status: "created",
      });
    } catch (err) {
      // 라벨링/탄생 실패는 이 후보만 건너뛴다 — 나머지 후보는 계속 진행(격리).
      outcomes.push({
        doc_ids: proposal.doc_ids,
        slug: null,
        name: null,
        description: null,
        status: "naming_failed",
        error: (err as Error).message,
      });
    }
  }

  return outcomes;
}

async function processMerges(
  proposals: MergeProposal[],
  state: LifecycleState,
  deps: LifecycleDeps,
  dryRun: boolean
): Promise<{ outcomes: MergeOutcome[]; nextStreaks: Record<string, number> }> {
  const outcomes: MergeOutcome[] = [];
  const nextStreaks: Record<string, number> = {};

  for (const proposal of proposals) {
    const key = mergeKey(proposal.a_id, proposal.b_id);
    const streak = (state.merge_streaks[key] ?? 0) + 1;
    nextStreaks[key] = streak;

    if (streak >= 2) {
      if (dryRun) {
        outcomes.push({ ...proposal, streak, status: "dry_run_would_merge" });
      } else {
        await deps.core.mergeClusters({ src_id: proposal.a_id, dst_id: proposal.b_id });
        outcomes.push({ ...proposal, streak, status: "merged" });
        nextStreaks[key] = 0; // 병합 완료 — 잔여 스트릭이 다음 실행에 남지 않게 초기화
      }
    } else {
      outcomes.push({ ...proposal, streak, status: "observed" });
    }
  }

  return { outcomes, nextStreaks };
}

function printRunSummary(result: LifecycleRunResult): void {
  const mode = result.dry_run ? "[dry-run] " : "";
  console.log(`${mode}lifecycle run: 탄생 후보 ${result.births.length}건, 병합 후보 ${result.merges.length}건`);
  for (const b of result.births) {
    console.log(`  [탄생] ${b.status} slug=${b.slug ?? "-"} docs=${b.doc_ids.length}건${b.error ? ` 오류=${b.error}` : ""}`);
  }
  for (const m of result.merges) {
    console.log(`  [병합] ${m.status} ${m.a_slug} + ${m.b_slug} (sim=${m.centroid_sim.toFixed(3)}, streak=${m.streak})`);
  }
}

export async function runLifecycle(deps: LifecycleDeps, opts: { dryRun?: boolean } = {}): Promise<LifecycleRunResult> {
  const dryRun = !!opts.dryRun;
  const dataDir = deps.dataDir ?? defaultDataDir();
  const state = await loadState(dataDir);

  const proposals: LifecycleProposalsResponse = await deps.core.getLifecycleProposals({
    birth_min: deps.config.birth_min,
    birth_cohesion: deps.config.birth_cohesion,
    merge_sim: deps.config.merge_sim,
  });

  const births = await processBirths(proposals.births, deps, dryRun);
  const { outcomes: merges, nextStreaks } = await processMerges(proposals.merges, state, deps, dryRun);

  if (!dryRun) {
    await saveState(dataDir, { merge_streaks: nextStreaks });
    try {
      await generateDigests({ core: deps.core, llm: deps.llm, dataDir });
    } catch (err) {
      console.warn(`다이제스트 생성 실패(무시하고 계속): ${(err as Error).message}`);
    }
  }

  const result: LifecycleRunResult = { births, merges, dry_run: dryRun };
  printRunSummary(result);
  return result;
}

function printStatus(result: LifecycleStatusResult): void {
  console.log(`lifecycle status: 탄생 후보 ${result.births_pending}건, 병합 후보 ${result.merges.length}건`);
  for (const m of result.merges) {
    const next = m.would_trigger_next_run ? "다음 관측 시 병합 트리거" : "관측 누적 중";
    console.log(`  ${m.a_slug} + ${m.b_slug} (sim=${m.centroid_sim.toFixed(3)}, streak=${m.streak}) — ${next}`);
  }
}

export async function lifecycleStatus(deps: {
  core: CoreClient;
  config: LifecycleConfig;
  dataDir?: string;
}): Promise<LifecycleStatusResult> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const state = await loadState(dataDir);

  const proposals = await deps.core.getLifecycleProposals({
    birth_min: deps.config.birth_min,
    birth_cohesion: deps.config.birth_cohesion,
    merge_sim: deps.config.merge_sim,
  });

  const merges: MergeStatusEntry[] = proposals.merges.map((p) => {
    const streak = state.merge_streaks[mergeKey(p.a_id, p.b_id)] ?? 0;
    return { ...p, streak, would_trigger_next_run: streak >= 1 };
  });

  const result: LifecycleStatusResult = { births_pending: proposals.births.length, merges };
  printStatus(result);
  return result;
}
