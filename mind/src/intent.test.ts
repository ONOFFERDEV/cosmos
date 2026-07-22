// classifyIntent 결정론적 분류 테스트. LLM 호출 없이 오탐 없이 동작해야 한다.
// CONTRACT.md "# M7 확장" 절 참고 — 애매하면 point 쪽으로 기운다.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyIntent } from "./intent.js";

const GLOBAL_CASES: string[] = [
  "전체 프로젝트 현황 보여줘",
  "지금 진행 중인 거 전부 알려줘",
  "모든 프로젝트 정리해줘",
  "회사에 있는 프로젝트 모두 보여줘",
  "프로젝트 목록 좀 줘",
  "전 프로젝트를 나열해줘",
  "회사 상황을 한눈에 보고 싶어",
  "요즘 뭐가 있는지 알려줘",
  "현황 요약해줘",
  "give me a full overview",
];

const POINT_CASES: string[] = [
  "docseal 설계 핵심이 뭐야?",
  "pervue 어디에 배포돼 있어?",
  "traxel 라이선스 서버는 어떻게 동작해?",
  "snipe-hub는 언제 만들었어?",
  "tikron의 아키텍처가 뭐야?",
  "psyfi 결제는 어떤 방식이야?",
  "grant-radar API 키는 어디서 받아?",
  "emberfall 다음 마일스톤이 뭐야?",
  "video-automation은 어떤 백엔드를 쓰고 있어?",
  "kcode의 핵심 아이디어가 뭐야?",
];

test("global 유형 질문 10개가 모두 global로 분류된다", () => {
  for (const q of GLOBAL_CASES) {
    assert.equal(classifyIntent(q), "global", `기대: global, 질문: "${q}"`);
  }
});

test("point 유형 질문 10개가 모두 point로 분류된다", () => {
  for (const q of POINT_CASES) {
    assert.equal(classifyIntent(q), "point", `기대: point, 질문: "${q}"`);
  }
});

test("빈 질문은 point로 분류된다", () => {
  assert.equal(classifyIntent(""), "point");
  assert.equal(classifyIntent("   "), "point");
});
