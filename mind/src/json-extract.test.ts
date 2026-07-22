import { test } from "node:test";
import assert from "node:assert/strict";

import { extractJson } from "./json-extract.js";

test("순수 JSON 문자열을 파싱한다", () => {
  assert.deepEqual(extractJson('{"a":1,"b":"x"}'), { a: 1, b: "x" });
});

test("json 태그 코드펜스 안의 JSON을 추출한다", () => {
  const text = '```json\n{"sentences":[{"text":"답변","cites":[1]}],"insufficient":false}\n```';
  assert.deepEqual(extractJson(text), {
    sentences: [{ text: "답변", cites: [1] }],
    insufficient: false,
  });
});

test("태그 없는 코드펜스 안의 JSON을 추출한다", () => {
  const text = '```\n{"slug":"llm-pipeline"}\n```';
  assert.deepEqual(extractJson(text), { slug: "llm-pipeline" });
});

test("전후 잡담 텍스트가 섞여 있어도 JSON을 추출한다", () => {
  const text = '네, 요청하신 결과는 다음과 같습니다:\n{"name":"클러스터"}\n필요하면 더 알려주세요.';
  assert.deepEqual(extractJson(text), { name: "클러스터" });
});

test("중첩된 중괄호를 올바르게 처리한다", () => {
  const text = '{"outer":{"inner":{"deep":1}},"list":[{"x":1},{"y":2}]}';
  assert.deepEqual(extractJson(text), { outer: { inner: { deep: 1 } }, list: [{ x: 1 }, { y: 2 }] });
});

test("JSON 객체가 없으면 에러를 던진다", () => {
  assert.throws(() => extractJson("그냥 평범한 문장입니다."));
});

test("중괄호가 닫히지 않으면 에러를 던진다", () => {
  assert.throws(() => extractJson('{"a": 1, "b": {"c": 2}'));
});
