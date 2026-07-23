// Per-deployment kit asset substitution — when another org spins this up, their own URL/template must be baked into the docs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderKitAsset } from "./server.js";

test("renderKitAsset은 PUBLIC_URL/TEMPLATE_REPO/TEMPLATE_ORG를 env로 치환한다", () => {
  process.env.COSMOS_PUBLIC_URL = "https://cosmos.acme.co/";
  process.env.COSMOS_TEMPLATE_REPO = "acme/kb-template";
  try {
    const out = renderKitAsset(
      "url={{PUBLIC_URL}}/kit repo={{TEMPLATE_REPO}} org={{TEMPLATE_ORG}}/knowledge-x"
    );
    assert.equal(out, "url=https://cosmos.acme.co/kit repo=acme/kb-template org=acme/knowledge-x");
  } finally {
    delete process.env.COSMOS_PUBLIC_URL;
    delete process.env.COSMOS_TEMPLATE_REPO;
  }
});

test("renderKitAsset은 env 미설정 시 안전한 기본값(localhost·기본 템플릿)을 쓴다", () => {
  delete process.env.COSMOS_PUBLIC_URL;
  delete process.env.COSMOS_TEMPLATE_REPO;
  const out = renderKitAsset("{{PUBLIC_URL}} {{TEMPLATE_REPO}}");
  assert.equal(out, "http://localhost:8800 ONOFFERDEV/knowledge-template");
});
