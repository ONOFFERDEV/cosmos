// global pipeline: for "full/complete enumeration" questions only. Answers that require
// completeness must come from a completeness-guaranteeing structure (full registry +
// cluster digests), not similarity search — the M7 principle.
// See CONTRACT.md "# M7 확장" section. search() is merged only as supplementary evidence.

import type { Entity, ClusterDigest } from "./core-client.js";
import type { NumberedChunk, Sentence, AskEnvelope, TraceEntry } from "./envelope.js";
import { assembleEnvelope } from "./envelope.js";
import { evaluateInsufficient } from "./guard.js";
import type { CitedSentence } from "./guard.js";
import type { AskDeps } from "./ask.js";
import { normalizeSentences, appendQueryLog } from "./ask.js";
import { completeJson } from "./llm.js";

const SEARCH_K = 6;

interface GlobalLlmResponse {
  sentences: unknown;
  insufficient?: boolean;
}

function formatEntityText(e: Entity): string {
  const parts = [`이름: ${e.name}`, `종류: ${e.kind}`];
  if (e.status) parts.push(`상태: ${e.status}`);
  if (e.phase) parts.push(`단계: ${e.phase}`);
  if (e.description) parts.push(`설명: ${e.description}`);
  if (e.next_action) parts.push(`다음 행동: ${e.next_action}`);
  if (e.blocked_on) parts.push(`차단 요인: ${e.blocked_on}`);
  if (e.updated) parts.push(`갱신: ${e.updated}`);
  return parts.join(" · ");
}

export function buildGlobalAskPrompt(question: string, chunks: NumberedChunk[]): string {
  const chunkText = chunks
    .map((c) => `[${c.n}] 출처: ${c.origin}${c.title ? ` (${c.title})` : ""}\n${c.text}`)
    .join("\n\n");
  return `당신은 사내 지식베이스 질의응답 어시스턴트입니다. 아래 [번호]가 매겨진 근거 자료만 사용해 질문에 답하세요.
이 질문은 "전체/전수 나열" 유형입니다 — 근거 자료에는 레지스트리 항목(전체 개체 목록)과 클러스터 다이제스트가 포함되어 있습니다.

규칙:
- 질문이 특정 종류(kind)의 전체 목록을 요구한다면, 근거 자료에 있는 해당 종류의 레지스트리 항목을 하나도 빠짐없이 답변에 반영하세요(상태나 영역별로 묶어 정리해도 됩니다).
- 근거 자료에 없는 개체나 사실을 지어내지 마세요.
- 반드시 제공된 근거 자료([1]..[${chunks.length}])만 사용하고, 답변의 모든 문장은 근거로 삼은 자료 번호를 cites 배열로 표시하세요. 근거가 없는 문장은 만들지 마세요.
- 근거 자료로 질문에 답할 수 없다면 insufficient를 true로 표시하세요.

근거 자료:
${chunkText || "(근거 자료 없음)"}

질문: ${question}

다음 JSON 형식으로만 답하세요 (설명이나 마크다운 없이 순수 JSON 객체 하나만):
{"sentences": [{"text": "문장 내용", "cites": [1, 2]}], "insufficient": false}`;
}

export async function runGlobalAsk(question: string, deps: AskDeps): Promise<AskEnvelope> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  let llmCalls = 0;

  // Start all three requests immediately/concurrently (preserving the original full-parallel
  // performance characteristics), but await each individually and fire onProgress right after
  // to guarantee the contractual registry -> digests -> search stage ordering.
  const entitiesPromise = deps.core.listEntities(undefined, deps.ownerScope);
  const digestsPromise = deps.core.listClusterDigests(deps.ownerScope);
  const searchPromise = deps.core.search({ query: question, k: SEARCH_K, owner_scope: deps.ownerScope });

  const entities = await entitiesPromise;
  deps.onProgress?.("registry", String(entities.length));

  const digests = await digestsPromise;
  deps.onProgress?.("digests", String(digests.length));

  const searchResponse = await searchPromise;
  deps.onProgress?.("search", String(searchResponse.results.length));

  const trace: TraceEntry[] = (digests as ClusterDigest[]).map((d) => ({
    cluster: d.slug,
    action: "consulted",
    why: "global digest",
  }));

  let n = 0;
  const chunks: NumberedChunk[] = [];

  for (const e of entities) {
    n += 1;
    chunks.push({
      n,
      origin: e.origin,
      title: e.name,
      chunk_id: `entity:${e.doc_id}`,
      char_start: 0,
      char_end: formatEntityText(e).length,
      text: formatEntityText(e),
    });
  }

  for (const d of digests) {
    n += 1;
    const chunk: NumberedChunk = {
      n,
      origin: `digest://${d.slug}`,
      chunk_id: `digest:${d.cluster_id}`,
      char_start: 0,
      char_end: d.text.length,
      text: d.text,
    };
    if (d.name !== undefined) chunk.title = d.name;
    chunks.push(chunk);
  }

  for (const r of searchResponse.results) {
    n += 1;
    const chunk: NumberedChunk = {
      n,
      origin: r.origin,
      chunk_id: r.chunk_id,
      char_start: r.char_start,
      char_end: r.char_end,
      text: r.text,
    };
    if (r.title !== undefined) chunk.title = r.title;
    chunks.push(chunk);
  }

  let sentences: Sentence[] = [];
  let insufficient: boolean;

  if (entities.length === 0 && digests.length === 0) {
    insufficient = true;
  } else {
    deps.onProgress?.("synthesize");
    const prompt = buildGlobalAskPrompt(question, chunks);
    const llmResponse = await completeJson<GlobalLlmResponse>(deps.llm, prompt);
    llmCalls += 1;
    sentences = normalizeSentences(llmResponse.sentences, chunks.length);
    const citedSentences: CitedSentence[] = sentences.map((s) => ({ text: s.text, cites: s.cites }));
    insufficient = evaluateInsufficient(Boolean(llmResponse.insufficient), citedSentences);
  }

  const secs = Math.round(((now() - startedAt) / 1000) * 100) / 100;

  deps.onProgress?.("assemble");
  const envelope = assembleEnvelope({
    sentences,
    chunks,
    trace,
    insufficient,
    cost: { llm_calls: llmCalls, secs, model: deps.llm.model },
    mode: "global",
  });

  await appendQueryLog(question, envelope, deps.dataDir);
  return envelope;
}
