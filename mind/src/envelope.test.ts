import { test } from "node:test";
import assert from "node:assert/strict";

import { numberSources, renderAnswer, assembleEnvelope } from "./envelope.js";
import type { NumberedChunk, Sentence, TraceEntry, Cost } from "./envelope.js";
import { BLOCK_MESSAGE } from "./guard.js";

function chunk(n: number, origin: string): NumberedChunk {
  return { n, origin, chunk_id: `c${n}`, char_start: 0, char_end: 10, text: `본문 ${n}` };
}

test("numberSources: 인용된 청크만 등장 순서대로 1..n 재번호를 매긴다", () => {
  const chunks = [chunk(1, "a.md"), chunk(2, "b.md"), chunk(3, "c.md")];
  const sentences: Sentence[] = [
    { text: "첫 문장", cites: [2] },
    { text: "둘째 문장", cites: [3, 2] },
  ];

  const { sources, sentences: remapped } = numberSources(chunks, sentences);

  assert.equal(sources.length, 2);
  assert.equal(sources[0]!.n, 1);
  assert.equal(sources[0]!.origin, "b.md");
  assert.equal(sources[1]!.n, 2);
  assert.equal(sources[1]!.origin, "c.md");

  assert.deepEqual(remapped[0]!.cites, [1]);
  assert.deepEqual(remapped[1]!.cites, [2, 1]);
});

test("numberSources: 인용되지 않은 청크는 sources에서 빠진다", () => {
  const chunks = [chunk(1, "a.md"), chunk(2, "b.md")];
  const sentences: Sentence[] = [{ text: "문장", cites: [] }];
  const { sources } = numberSources(chunks, sentences);
  assert.deepEqual(sources, []);
});

test("renderAnswer: 문장 텍스트와 인용 번호를 이어붙인다", () => {
  const sentences: Sentence[] = [
    { text: "첫 문장", cites: [1] },
    { text: "둘째 문장", cites: [2, 1] },
  ];
  assert.equal(renderAnswer(sentences), "첫 문장 [1] 둘째 문장 [2][1]");
});

test("renderAnswer: 인용 없는 문장은 번호 없이 그대로 붙는다", () => {
  assert.equal(renderAnswer([{ text: "인용 없음", cites: [] }]), "인용 없음");
});

test("assembleEnvelope: 정상 응답이면 재번호 매긴 sources와 trace를 포함한다", () => {
  const chunks = [chunk(1, "a.md"), chunk(2, "b.md")];
  const sentences: Sentence[] = [{ text: "답변 문장", cites: [2] }];
  const trace: TraceEntry[] = [{ cluster: "llm-pipeline", action: "consulted", why: "score 0.81 (rank 1)" }];
  const cost: Cost = { llm_calls: 1, secs: 1.23, model: "sonnet" };

  const envelope = assembleEnvelope({ sentences, chunks, trace, insufficient: false, cost });

  assert.equal(envelope.mode, "fast");
  assert.equal(envelope.insufficient, false);
  assert.deepEqual(envelope.trace, trace);
  assert.deepEqual(envelope.cost, cost);
  assert.equal(envelope.sources.length, 1);
  assert.equal(envelope.sources[0]!.n, 1);
  assert.equal(envelope.sources[0]!.origin, "b.md");
  assert.equal(envelope.answer, "답변 문장 [1]");
  assert.deepEqual(envelope.sentences[0]!.cites, [1]);
});

test("assembleEnvelope: insufficient면 BLOCK_MESSAGE를 answer로 사용한다", () => {
  const cost: Cost = { llm_calls: 0, secs: 0.1, model: "sonnet" };
  const envelope = assembleEnvelope({ sentences: [], chunks: [], trace: [], insufficient: true, cost });
  assert.equal(envelope.answer, BLOCK_MESSAGE);
  assert.deepEqual(envelope.sources, []);
});

test("assembleEnvelope: insufficientAnswer가 주어지면 BLOCK_MESSAGE 대신 사용한다", () => {
  const cost: Cost = { llm_calls: 0, secs: 0.1, model: "sonnet" };
  const envelope = assembleEnvelope({
    sentences: [],
    chunks: [],
    trace: [],
    insufficient: true,
    cost,
    insufficientAnswer: "커스텀 메시지",
  });
  assert.equal(envelope.answer, "커스텀 메시지");
});
